import request from "supertest";
import type { Application } from "express";

// NFR-121: a session revoked on one instance stops working on another. Skipped without DATABASE_URL.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

process.env.SESSION_DB_PERSISTENCE = "true";
process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
process.env.SESSION_REVOCATION_CHECK_SECONDS = "0.2";

describeDb("Sprint 9 database-backed behaviour", () => {
  let app: Application;
  let basePrisma: typeof import("../src/db.js").basePrisma;

  beforeAll(async () => {
    ({ basePrisma } = await import("../src/db.js"));
    app = (await import("../src/app.js")).createApp();
  });
  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  async function signIn() {
    const res = await request(app).post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
    return { token: res.body.accessToken as string, sessionId: res.body.session.sessionId as string };
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("refuses a session that another instance revoked, within the check interval", async () => {
    const { token, sessionId } = await signIn();
    await request(app).get("/api/v1/queue").set("Authorization", `Bearer ${token}`).expect(200);

    // Another instance revokes the session: only the shared row knows.
    const rows = await basePrisma.userSession.findMany({ orderBy: { createdAt: "desc" }, take: 30 });
    const row = rows.find((r) => (r.sessionPayload as { sessionId?: string }).sessionId === sessionId)!;
    expect(row).toBeDefined();
    await basePrisma.userSession.update({ where: { id: row.id }, data: { revokedAt: new Date() } });

    await sleep(400);
    await request(app).get("/api/v1/queue").set("Authorization", `Bearer ${token}`).expect(401);
  }, 20_000);

  it("keeps a session that has not been revoked", async () => {
    const { token } = await signIn();
    await sleep(300);
    await request(app).get("/api/v1/queue").set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(300);
    await request(app).get("/api/v1/queue").set("Authorization", `Bearer ${token}`).expect(200);
  }, 20_000);
});
