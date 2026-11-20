import { publishEvent } from "./eventBus.js";
import { diagnoseFailure } from "./failureDiagnosis.js";
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { shouldPersistPlatformInDatabase } from "../config/runtime.js";
import { backoffMs } from "./webhooks.js";

/**
 * Queue-based processing for integrations (NFR-094). Work for other systems is written to a durable queue first
 * and done by a worker, so an unavailable external system never blocks the product and a restart loses nothing.
 * Each job is retried with exponential back-off; after INTEGRATION_JOB_MAX_ATTEMPTS (default 6) it moves to the
 * dead-letter state where an administrator can see why and replay it.
 *
 * Without a database (local development and the demo) a job runs immediately instead, so behaviour is the same
 * but nothing is durable.
 */

export type JobHandler = (payload: Record<string, unknown>, job: { id: string; correlationId: string; attempt: number }) => Promise<void>;
const handlers = new Map<string, JobHandler>();
export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}
export function jobHandlerTypes(): string[] {
  return [...handlers.keys()];
}

function maxAttempts(): number {
  const n = Number(process.env.INTEGRATION_JOB_MAX_ATTEMPTS);
  return Number.isInteger(n) && n > 0 ? n : 6;
}
function policy() {
  const base = Number(process.env.INTEGRATION_JOB_BACKOFF_BASE_MS);
  return { maxAttempts: maxAttempts(), baseDelayMs: Number.isFinite(base) && base > 0 ? base : 10_000 };
}

export async function enqueueJob(args: { type: string; payload: Record<string, unknown>; correlationId?: string; maxAttempts?: number }): Promise<string> {
  const correlationId = args.correlationId ?? randomUUID();
  if (!shouldPersistPlatformInDatabase()) {
    const handler = handlers.get(args.type);
    if (!handler) throw new Error(`No handler for integration job type ${args.type}.`);
    const id = `inline-${randomUUID()}`;
    await handler(args.payload, { id, correlationId, attempt: 1 });
    return id;
  }
  const row = await prisma.integrationJob.create({ data: { type: args.type, payload: args.payload as never, correlationId, maxAttempts: args.maxAttempts ?? maxAttempts() } });
  return row.id;
}

export type JobRun = { attempted: number; succeeded: number; retried: number; dead: number };

export async function processJobs(options: { limit?: number; now?: Date; types?: string[] } = {}): Promise<JobRun> {
  const now = options.now ?? new Date();
  const result: JobRun = { attempted: 0, succeeded: 0, retried: 0, dead: 0 };
  const due = await prisma.integrationJob.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }], ...(options.types ? { type: { in: options.types } } : {}) },
    orderBy: { nextAttemptAt: "asc" },
    take: options.limit ?? 25
  });
  for (const job of due) {
    const claimed = await prisma.integrationJob.updateMany({ where: { id: job.id, status: "pending", OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }, data: { lockedUntil: new Date(now.getTime() + 120_000) } });
    if (claimed.count !== 1) continue;
    result.attempted += 1;
    const attempt = job.attempts + 1;
    try {
      const handler = handlers.get(job.type);
      if (!handler) throw new Error(`No handler for ${job.type}`);
      await handler(job.payload as Record<string, unknown>, { id: job.id, correlationId: job.correlationId, attempt });
      await prisma.integrationJob.update({ where: { id: job.id }, data: { status: "succeeded", attempts: attempt, lastError: null, completedAt: now, lockedUntil: null } });
      result.succeeded += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : "error").slice(0, 500);
      if (attempt >= job.maxAttempts) {
        await prisma.integrationJob.update({ where: { id: job.id }, data: { status: "dead", attempts: attempt, lastError: message, lockedUntil: null } });
        result.dead += 1;
        // NFR-045: the alert says why it failed and what to check first.
        const diagnosis = diagnoseFailure(message);
        await publishEvent({ id: `job-dead-${job.id}`, type: "job.failed", occurredAtIso: now.toISOString(), subject: job.type, risk: "medium", success: false, data: { job: job.type, handler: job.type, jobId: job.id, attempts: attempt, reason: message, category: diagnosis.category, likelyCause: diagnosis.likelyCause, firstCheck: diagnosis.firstCheck } }).catch(() => undefined);
      } else {
        await prisma.integrationJob.update({ where: { id: job.id }, data: { attempts: attempt, lastError: message, nextAttemptAt: new Date(now.getTime() + backoffMs(attempt, policy())), lockedUntil: null } });
        result.retried += 1;
      }
    }
  }
  return result;
}

export async function replayJobs(filter: { id?: string; type?: string }): Promise<number> {
  return (await prisma.integrationJob.updateMany({ where: { status: "dead", ...(filter.id ? { id: filter.id } : {}), ...(filter.type ? { type: filter.type } : {}) }, data: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lockedUntil: null, lastError: null } })).count;
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startJobWorker(everyMs = 5000): void {
  if (timer || !shouldPersistPlatformInDatabase()) return;
  timer = setInterval(() => void processJobs().catch((e) => console.error(JSON.stringify({ type: "job_worker_failed", error: e instanceof Error ? e.name : "error" }))), everyMs);
  timer.unref?.();
}
