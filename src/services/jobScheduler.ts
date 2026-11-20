import { z } from "zod";
import { WorkError, createItem, getItem, listItems, updateItem, type WorkItem } from "./clinicalWork.js";
import { diagnoseFailure, type Diagnosis } from "./failureDiagnosis.js";
import { publishEvent } from "./eventBus.js";
import { isConstrained, resourceStatus } from "./resourceGuard.js";

/**
 * The application's own job scheduler (NFR-041, 042, 043, 046, 039).
 *   modes     cron (calendar date and time, repeating), once (one date and time), times (a cron schedule that stops
 *             after N runs) and manual (runs only when someone starts it)
 *   runs      every execution is recorded with start, end, duration, attempts and outcome
 *   retries   a failing run is retried up to maxAttempts with doubling back-off; attempts are visible per run
 *   cancel    a running execution can be cancelled, and a schedule can be switched off
 *   pressure  a non-critical job is deferred while the instance is constrained; critical jobs always run
 * Times are in UTC unless the schedule names Asia/Qatar (UTC+3, no daylight saving).
 */

export const MODES = ["cron", "once", "times", "manual"] as const;
const TIMEZONES = { UTC: 0, "Asia/Qatar": 180 } as const;

export const ScheduleInput = z.object({
  name: z.string().trim().min(3).max(120),
  handler: z.string().trim().min(2).max(80),
  mode: z.enum(MODES),
  cron: z.string().trim().max(100).optional(),
  runAtIso: z.string().datetime().optional(),
  times: z.number().int().min(1).max(10_000).optional(),
  timezone: z.enum(["UTC", "Asia/Qatar"]).default("UTC"),
  priority: z.enum(["critical", "non_critical"]).default("non_critical"),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  params: z.record(z.unknown()).default({})
}).superRefine((v, ctx) => {
  if ((v.mode === "cron" || v.mode === "times") && !v.cron) ctx.addIssue({ code: "custom", message: "A cron expression is required.", path: ["cron"] });
  if (v.cron) {
    try {
      parseCron(v.cron);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: (e as Error).message, path: ["cron"] });
    }
  }
  if (v.mode === "once" && !v.runAtIso) ctx.addIssue({ code: "custom", message: "A date and time is required.", path: ["runAtIso"] });
  if (v.mode === "times" && !v.times) ctx.addIssue({ code: "custom", message: "A number of runs is required.", path: ["times"] });
});
export type ScheduleInputType = z.infer<typeof ScheduleInput>;

// ---- cron ---------------------------------------------------------------------------------------------

type Field = Set<number>;
function parseField(text: string, min: number, max: number): Field {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${part}".`);
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = b === undefined ? (stepText === undefined ? lo : max) : Number(b);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) throw new Error(`"${part}" is outside ${min} to ${max}.`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expression: string): { minute: Field; hour: Field; dom: Field; month: Field; dow: Field; domAny: boolean; dowAny: boolean } {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A cron expression has five fields: minute hour day-of-month month day-of-week.");
  const dow = parseField(parts[4], 0, 7);
  if (dow.has(7)) dow.add(0);
  return { minute: parseField(parts[0], 0, 59), hour: parseField(parts[1], 0, 23), dom: parseField(parts[2], 1, 31), month: parseField(parts[3], 1, 12), dow, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

/** The next time after `from` that the expression fires, or undefined within a year. */
export function nextCronTime(expression: string, from: Date, timezone: keyof typeof TIMEZONES = "UTC"): Date | undefined {
  const c = parseCron(expression);
  const offsetMs = TIMEZONES[timezone] * 60_000;
  const t = new Date(Math.floor((from.getTime() + offsetMs) / 60_000) * 60_000 + 60_000); // shifted clock, next whole minute
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    const monthOk = c.month.has(t.getUTCMonth() + 1);
    if (!monthOk) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const domOk = c.dom.has(t.getUTCDate());
    const dowOk = c.dow.has(t.getUTCDay());
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk;
    if (!dayOk) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (c.minute.has(t.getUTCMinutes())) return new Date(t.getTime() - offsetMs);
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return undefined;
}

// ---- handlers -------------------------------------------------------------------------------------------

export type JobContext = { signal: AbortSignal; params: Record<string, unknown>; attempt: number; scheduleId: string; runId: string };
export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;
const handlers = new Map<string, JobHandler>();
export function registerSchedulerHandler(name: string, handler: JobHandler): void {
  handlers.set(name, handler);
}
export function schedulerHandlerNames(): string[] {
  return [...handlers.keys()].sort();
}

// ---- schedules --------------------------------------------------------------------------------------------

export type Schedule = { id: string; status: string; name: string; handler: string; mode: string; cron?: string; runAtIso?: string; timesRemaining?: number; timezone: string; priority: string; maxAttempts: number; params: Record<string, unknown>; nextRunAtIso: string | null; lastRunAtIso: string | null; deferrals: number; createdBy: string };

const toSchedule = (item: WorkItem): Schedule => ({
  id: item.id, status: item.status, name: String(item.payload.name), handler: String(item.payload.handler), mode: String(item.payload.mode), cron: item.payload.cron as string | undefined,
  runAtIso: item.payload.runAtIso as string | undefined, timesRemaining: item.payload.timesRemaining as number | undefined, timezone: String(item.payload.timezone ?? "UTC"), priority: String(item.payload.priority ?? "non_critical"),
  maxAttempts: Number(item.payload.maxAttempts ?? 3), params: (item.payload.params ?? {}) as Record<string, unknown>, nextRunAtIso: (item.payload.nextRunAtIso as string | null) ?? null,
  lastRunAtIso: (item.payload.lastRunAtIso as string | null) ?? null, deferrals: Number(item.payload.deferrals ?? 0), createdBy: item.createdBy
});

function computeNext(input: { mode: string; cron?: string; runAtIso?: string; timezone: string }, from: Date): string | null {
  if (input.mode === "manual") return null;
  if (input.mode === "once") return input.runAtIso ?? null;
  return nextCronTime(input.cron!, from, input.timezone as keyof typeof TIMEZONES)?.toISOString() ?? null;
}

export async function createSchedule(input: ScheduleInputType, userId: string, now = new Date()): Promise<Schedule> {
  if (!handlers.has(input.handler)) throw new WorkError(400, `Unknown handler "${input.handler}". Known: ${schedulerHandlerNames().join(", ")}.`, "SCHEDULE_HANDLER_UNKNOWN");
  const item = await createItem({
    kind: "schedule", status: "active", createdBy: userId,
    payload: { ...input, timesRemaining: input.mode === "times" ? input.times : undefined, nextRunAtIso: computeNext(input, now), lastRunAtIso: null, deferrals: 0 }
  });
  return toSchedule(item);
}

export async function listSchedules(): Promise<Schedule[]> {
  return (await listItems({ kind: "schedule", limit: 500 })).filter((i) => i.status !== "cancelled").map(toSchedule);
}

export async function setScheduleEnabled(id: string, enabled: boolean): Promise<Schedule> {
  const item = await getItem(id, "schedule");
  if (!item) throw new WorkError(404, "Schedule not found.", "SCHEDULE_NOT_FOUND");
  if (item.status === "cancelled" || item.status === "completed") throw new WorkError(409, "That schedule has ended.", "SCHEDULE_ENDED");
  return toSchedule(await updateItem(id, { status: enabled ? "active" : "paused", payload: enabled ? { nextRunAtIso: computeNext(item.payload as never, new Date()) } : {} }));
}

export async function cancelSchedule(id: string): Promise<Schedule> {
  const item = await getItem(id, "schedule");
  if (!item) throw new WorkError(404, "Schedule not found.", "SCHEDULE_NOT_FOUND");
  return toSchedule(await updateItem(id, { status: "cancelled", payload: { nextRunAtIso: null } }));
}

// ---- runs ------------------------------------------------------------------------------------------------

export type Run = { id: string; scheduleId: string; status: string; trigger: string; startedAtIso: string; endedAtIso: string | null; durationMs: number | null; attempts: number; maxAttempts: number; error: string | null; result: unknown; diagnosis: Diagnosis | null };
const toRun = (item: WorkItem): Run => ({ id: item.id, scheduleId: String(item.caseRef), status: item.status, trigger: String(item.payload.trigger), startedAtIso: String(item.payload.startedAtIso), endedAtIso: (item.payload.endedAtIso as string | null) ?? null, durationMs: (item.payload.durationMs as number | null) ?? null, attempts: Number(item.payload.attempts ?? 0), maxAttempts: Number(item.payload.maxAttempts ?? 1), error: (item.payload.error as string | null) ?? null, result: item.payload.result ?? null, diagnosis: (item.payload.diagnosis as Diagnosis | undefined) ?? null });

export async function listRuns(scheduleId?: string, limit = 100): Promise<Run[]> {
  return (await listItems({ kind: "job_run", caseRef: scheduleId, limit })).map(toRun);
}

const controllers = new Map<string, AbortController>();
let sleeper: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function setSchedulerSleepForTests(fn: ((ms: number) => Promise<void>) | undefined): void {
  sleeper = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}
const backoff = (attempt: number) => Math.min(60_000, 1000 * 2 ** (attempt - 1));

/** Records the run as started and begins it; `done` settles when it has finished. */
async function startRun(schedule: Schedule, trigger: "schedule" | "manual", now = new Date()): Promise<{ run: WorkItem; done: Promise<Run> }> {
  const run = await createItem({ kind: "job_run", status: "running", caseRef: schedule.id, createdBy: trigger === "manual" ? "user" : "scheduler", payload: { trigger, startedAtIso: now.toISOString(), attempts: 0, maxAttempts: schedule.maxAttempts, endedAtIso: null, durationMs: null, error: null } });
  return { run, done: execute(schedule, run, now) };
}

async function execute(schedule: Schedule, run: WorkItem, now: Date): Promise<Run> {
  const handler = handlers.get(schedule.handler);
  const startedAt = now.getTime();
  const controller = new AbortController();
  controllers.set(run.id, controller);
  let error: string | null = null;
  let result: Record<string, unknown> | void = undefined;
  let attempts = 0;
  try {
    for (attempts = 1; attempts <= schedule.maxAttempts; attempts += 1) {
      if (controller.signal.aborted) break;
      await updateItem(run.id, { payload: { attempts } });
      try {
        if (!handler) throw new Error(`No handler "${schedule.handler}".`);
        result = await handler({ signal: controller.signal, params: schedule.params, attempt: attempts, scheduleId: schedule.id, runId: run.id });
        error = null;
        break;
      } catch (caught) {
        error = caught instanceof Error ? caught.message.slice(0, 500) : "failed";
        if (controller.signal.aborted || attempts >= schedule.maxAttempts) break;
        await sleeper(backoff(attempts));
      }
    }
  } finally {
    controllers.delete(run.id);
  }
  const cancelled = controller.signal.aborted;
  const ended = Date.now();
  // NFR-045: a failed run carries the reason and the likely cause, in the record and in the alert.
  const diagnosis = error && !cancelled ? diagnoseFailure(error) : undefined;
  const final = await updateItem(run.id, { status: cancelled ? "cancelled" : error ? "failed" : "succeeded", payload: { endedAtIso: new Date(ended).toISOString(), durationMs: ended - startedAt, attempts: Math.min(attempts, schedule.maxAttempts), error: cancelled ? "Cancelled." : error, result: result ?? null, ...(diagnosis ? { diagnosis } : {}) } });
  if (diagnosis) {
    await publishEvent({
      id: `job-failed-${run.id}`, type: "job.failed", occurredAtIso: new Date(ended).toISOString(), subject: schedule.handler, risk: "medium", success: false,
      data: { job: schedule.name, handler: schedule.handler, runId: run.id, attempts: Math.min(attempts, schedule.maxAttempts), reason: error, category: diagnosis.category, likelyCause: diagnosis.likelyCause, firstCheck: diagnosis.firstCheck }
    }).catch(() => undefined);
  }
  return toRun(final);
}

/** A user starts a schedule now, whatever its mode (user-triggered). */
export async function runNow(id: string, options: { wait?: boolean; now?: Date } = {}): Promise<Run> {
  const now = options.now ?? new Date();
  const item = await getItem(id, "schedule");
  if (!item) throw new WorkError(404, "Schedule not found.", "SCHEDULE_NOT_FOUND");
  const { run, done } = await startRun(toSchedule(item), "manual", now);
  await updateItem(id, { payload: { lastRunAtIso: now.toISOString() } });
  if (options.wait === false) {
    void done.catch(() => undefined);
    return toRun(run);
  }
  return done;
}

export async function getRun(runId: string): Promise<Run | undefined> {
  const item = await getItem(runId, "job_run");
  return item ? toRun(item) : undefined;
}

export async function cancelRun(runId: string): Promise<Run> {
  const item = await getItem(runId, "job_run");
  if (!item) throw new WorkError(404, "Run not found.", "RUN_NOT_FOUND");
  if (item.status !== "running") throw new WorkError(409, "Only a running execution can be cancelled.", "RUN_NOT_RUNNING");
  const controller = controllers.get(runId);
  if (!controller) {
    // Started by another instance (or left over from a restart): record the cancellation; that instance stops at its next check.
    return toRun(await updateItem(runId, { status: "cancelled", payload: { endedAtIso: new Date().toISOString(), error: "Cancelled." } }));
  }
  controller.abort();
  return toRun((await getItem(runId, "job_run"))!);
}

/** One pass of the scheduler: starts what is due. Returns what happened, for the worker and for tests. */
export async function tick(now = new Date()): Promise<{ started: string[]; deferred: string[] }> {
  const started: string[] = [];
  const deferred: string[] = [];
  const constrained = isConstrained();
  for (const item of await listItems({ kind: "schedule", status: "active", limit: 500 })) {
    const s = toSchedule(item);
    if (!s.nextRunAtIso || new Date(s.nextRunAtIso).getTime() > now.getTime()) continue;
    if (constrained && s.priority === "non_critical") {
      await updateItem(s.id, { payload: { deferrals: s.deferrals + 1, deferredReason: resourceStatus().reasons.join("; ") } });
      deferred.push(s.id);
      continue;
    }
    // Move the next time on before running, so a slow run is not started twice.
    const remaining = s.mode === "times" ? (s.timesRemaining ?? 1) - 1 : undefined;
    const ends = s.mode === "once" || (s.mode === "times" && remaining === 0);
    await updateItem(s.id, { status: ends ? "completed" : "active", payload: { nextRunAtIso: ends ? null : computeNext({ mode: s.mode, cron: s.cron, timezone: s.timezone }, now), lastRunAtIso: now.toISOString(), ...(remaining !== undefined ? { timesRemaining: remaining } : {}) } });
    started.push(s.id);
    void startRun(s, "schedule", now).then(({ done }) => done).catch(() => undefined);
  }
  return { started, deferred };
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startSchedulerWorker(everyMs = 15_000): void {
  if (timer) return;
  timer = setInterval(() => void tick().catch((e) => console.error(JSON.stringify({ type: "scheduler_failed", error: e instanceof Error ? e.name : "error" }))), everyMs);
  timer.unref?.();
}
export function stopSchedulerWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Wait for in-process runs to finish (tests). */
export async function idle(maxMs = 2000): Promise<void> {
  const until = Date.now() + maxMs;
  while (controllers.size > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
}
