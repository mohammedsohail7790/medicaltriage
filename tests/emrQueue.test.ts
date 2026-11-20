import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { registerJobHandler } from "../src/services/integrationQueue.js";
import { resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
const app = createApp();

describe("NFR-094 EMR write-back through the job queue", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    resetSecurityStoreForTests();
    resetRateLimitBucketsForTests();
  });
  afterEach(() => {
    process.env = { ...originalEnv, ADMIN_PASSWORD: "TestAdminPassword!2026" };
  });
  async function nurse() {
    const agent = request.agent(app);
    await agent.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
    return agent;
  }

  it("queues the write-back and answers at once when asked to, without waiting for the EMR", async () => {
    const seen: Array<Record<string, unknown>> = [];
    registerJobHandler("emr.writeback", async (payload, job) => {
      seen.push({ ...payload, correlationId: job.correlationId });
    });
    const agent = await nurse();
    const response = await agent.post("/api/v1/emr/writeback/enc-1?async=true").send({ dryRun: true }).expect(202);
    expect(response.body).toMatchObject({ queued: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ encounterId: "enc-1", options: { dryRun: true } });
    expect(seen[0].organizationId).toBeTruthy();
  });

  it("can be made the default for the whole service", async () => {
    process.env.EMR_WRITEBACK_ASYNC = "true";
    const seen: string[] = [];
    registerJobHandler("emr.writeback", async (payload) => void seen.push(String(payload.encounterId)));
    const agent = await nurse();
    await agent.post("/api/v1/emr/writeback/enc-2").send({}).expect(202);
    expect(seen).toEqual(["enc-2"]);
    // An explicit ?async=false still runs it directly.
    const direct = await agent.post("/api/v1/emr/writeback/enc-3?async=false").send({ dryRun: true });
    expect(direct.status).not.toBe(202);
  });
});
