import { readFileSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { tryItConsoleEnabled } from "../src/routes/apiDocsRouter.js";

const TEST_ADMIN_PASSWORD = "TestAdminPassword!2026";
process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
const app = createApp();

// NFR-001 / NFR-002: the reference page is a shell with no API content; the specification needs a session.
describe("API reference portal", () => {
  it("serves a shell that does not list endpoints without authentication", async () => {
    const response = await request(app).get("/api-docs").expect(200);
    expect(response.type).toBe("text/html");
    expect(response.text).not.toContain("/api/v1/auth/session");
    expect(response.text).toContain("/api-docs/viewer.js");
  });

  it("refuses the raw specification without credentials", async () => {
    await request(app).get("/api-docs/openapi.json").expect(401);
  });

  it("serves the specification to an authenticated caller", async () => {
    const agent = request.agent(app);
    await agent.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: TEST_ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
    const response = await agent.get("/api-docs/openapi.json").expect(200);
    expect(response.body.openapi).toEqual(expect.any(String));
    expect(response.body.paths["/api/v1/auth/session"]).toBeDefined();
  });

  it("offers the try-it console only outside production", () => {
    expect(tryItConsoleEnabled({ NODE_ENV: "production" } as never)).toBe(false);
    expect(tryItConsoleEnabled({ NODE_ENV: "development" } as never)).toBe(true);
    expect(tryItConsoleEnabled({ NODE_ENV: "development", API_TRY_IT_ENABLED: "false" } as never)).toBe(false);
  });

  it("is built from the published specification file", () => {
    const spec = JSON.parse(readFileSync(path.resolve(process.cwd(), "docs", "openapi.json"), "utf8"));
    expect(Object.keys(spec.paths).length).toBeGreaterThan(100);
  });
});
