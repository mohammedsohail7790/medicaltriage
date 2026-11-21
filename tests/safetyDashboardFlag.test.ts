import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

const TEST_ADMIN_PASSWORD = "TestAdminPassword!2026";
process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;

// F-019: without a database the dashboard serves fixed examples, and says so. It never invents a manual baseline.
describe("safety dashboard demonstration flag", () => {
  beforeEach(() => {
    resetSecurityStoreForTests();
    resetRateLimitBucketsForTests();
  });

  it("marks the fixed figures as demonstration data when no database is in use", async () => {
    const app = createApp();
    const manager = request.agent(app);
    await manager
      .post("/api/v1/auth/login")
      .send({ username: "khalid@irisstar.tech", password: TEST_ADMIN_PASSWORD, simulateRole: "triage_service_manager" })
      .expect(200);
    const response = await manager.get("/api/v1/approval/dashboard").expect(200);
    expect(response.body.demonstrationData).toBe(true);
    expect(response.body.kpis.totalCallVolume).toBe(218);
  });
});
