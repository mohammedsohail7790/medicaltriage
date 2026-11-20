import request from "supertest";
import { createApp } from "../src/app.js";
import { toProblem, validateSunsetNotice, versionCatalogue } from "../src/middleware/apiVersioning.js";

describe("NFR-006 API versioning", () => {
  const app = createApp();

  it("serves the same route under v1 and v2", async () => {
    const v1 = await request(app).get("/api/v1/runtime/environment");
    const v2 = await request(app).get("/api/v2/runtime/environment");
    expect(v1.status).toBe(200);
    expect(v2.status).toBe(200);
    expect(v1.headers["api-version"]).toBe("v1");
    expect(v2.headers["api-version"]).toBe("v2");
  });

  it("keeps the legacy error shape on v1 and problem+json on v2", async () => {
    const v1 = await request(app).get("/api/v1/nope");
    expect(v1.status).toBe(404);
    expect(v1.body).toMatchObject({ error: "Route not found" });
    const v2 = await request(app).get("/api/v2/nope");
    expect(v2.status).toBe(404);
    expect(v2.headers["content-type"]).toContain("application/problem+json");
    expect(v2.body).toMatchObject({ status: 404, title: "Not Found", detail: "Route not found", instance: "/api/v2/nope" });
  });

  it("publishes the version catalogue and policy", async () => {
    const res = await request(app).get("/api/v1/versions");
    expect(res.status).toBe(200);
    expect(res.body.versions.map((v: { version: string }) => v.version)).toEqual(["v1", "v2"]);
    expect(res.body.policy.minimumNoticeDays).toBe(90);
  });

  it("marks v1 deprecated with Deprecation and Sunset headers when configured", async () => {
    process.env.API_V1_DEPRECATED_AT = "2027-01-01T00:00:00Z";
    process.env.API_V1_SUNSET_AT = "2027-06-01T00:00:00Z";
    try {
      const res = await request(app).get("/api/v1/runtime/environment");
      expect(res.headers.deprecation).toMatch(/^@\d+$/);
      expect(res.headers.sunset).toContain("2027");
      expect(res.headers.link).toContain("successor-version");
      expect(versionCatalogue()[0].status).toBe("deprecated");
    } finally {
      delete process.env.API_V1_DEPRECATED_AT;
      delete process.env.API_V1_SUNSET_AT;
    }
  });

  it("rejects a sunset shorter than the notice period", () => {
    expect(validateSunsetNotice({ API_V1_DEPRECATED_AT: "2027-01-01", API_V1_SUNSET_AT: "2027-02-01" } as never)).toMatch(/90 days/);
    expect(validateSunsetNotice({ API_V1_DEPRECATED_AT: "2027-01-01", API_V1_SUNSET_AT: "2027-06-01" } as never)).toBeNull();
  });

  it("builds problem documents", () => {
    expect(toProblem(429, { error: "slow", retryAfterSeconds: 3 }, "/x", "r1")).toMatchObject({ status: 429, detail: "slow", retryAfterSeconds: 3, requestId: "r1" });
  });
});
