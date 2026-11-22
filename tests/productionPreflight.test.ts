import { productionPreflight } from "../src/config/productionPreflight.js";

describe("production preflight (OI-51)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("fails a demo environment and names the problems together", () => {
    process.env.NODE_ENV = "development";
    process.env.MOCK_MODE = "true";
    const findings = productionPreflight();
    const checks = findings.filter((f) => f.level === "fail").map((f) => f.check);
    expect(checks).toEqual(expect.arrayContaining(["NODE_ENV", "MOCK_MODE", "call-centre gateway"]));
  });

  it("reports a missing secret from the startup assertion", () => {
    process.env.NODE_ENV = "production";
    process.env.MOCK_MODE = "false";
    delete process.env.AUTH_JWT_SECRET;
    const findings = productionPreflight();
    expect(findings.some((f) => f.check === "runtime configuration" && /AUTH_JWT_SECRET/.test(f.detail))).toBe(true);
  });
});
