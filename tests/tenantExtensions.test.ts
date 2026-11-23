import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { resetClinicalWorkForTests } from "../src/services/clinicalWork.js";
import { listClinicalProtocols } from "../src/services/clinicalContent.js";
import { FLAG_DEFINITIONS, flagEnabled, flagHistory, listFlags, resetFlagsCacheForTests, setFlag } from "../src/services/featureFlags.js";
import { hiddenProtocolIds, resetProtocolSetCacheForTests, setProtocolSet, protocolSetView } from "../src/services/protocolSets.js";
import { enqueueForEvent } from "../src/services/webhooks.js";
import { resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";

beforeEach(() => {
  resetClinicalWorkForTests();
  resetFlagsCacheForTests();
  resetProtocolSetCacheForTests();
});

describe("NFR-072 feature flags per organisation", () => {
  it("start at their defaults and reject unknown flags", async () => {
    for (const d of FLAG_DEFINITIONS) expect(flagEnabled(d.key)).toBe(d.default);
    expect(() => flagEnabled("nope")).toThrow(/Unknown feature flag/);
  });

  it("validate the value and require a reason", async () => {
    await expect(setFlag("webhooks.delivery", "no", "u", "Because I said so")).rejects.toMatchObject({ code: "FLAG_VALUE_INVALID" });
    await expect(setFlag("webhooks.delivery", false, "u", "")).rejects.toMatchObject({ code: "FLAG_REASON_REQUIRED" });
    await expect(setFlag("nope", true, "u", "Because I said so")).rejects.toMatchObject({ code: "FLAG_UNKNOWN" });
  });

  it("take effect at once, with who and why recorded", async () => {
    await setFlag("voice.assessment", false, "usr_a", "Not part of the pilot");
    expect(flagEnabled("voice.assessment")).toBe(false);
    await setFlag("voice.assessment", true, "usr_b", "Pilot widened");
    const history = await flagHistory("voice.assessment");
    expect(history.map((h) => [h.version, h.previous, h.value, h.by])).toEqual(expect.arrayContaining([[1, true, false, "usr_a"], [2, false, true, "usr_b"]]));
    expect((await listFlags()).find((f) => f.key === "voice.assessment")).toMatchObject({ value: true, version: 2, isDefault: true });
  });

  it("do not include any clinical safeguard", () => {
    for (const d of FLAG_DEFINITIONS) expect(d.key).not.toMatch(/safety|floor|approval|disposition|severity/i);
  });

  it("turn off the real behaviour they name", async () => {
    const app = createApp();
    resetSecurityStoreForTests();
    resetRateLimitBucketsForTests();
    const agent = request.agent(app);
    await agent.post("/api/v1/auth/login").send({ username: "rishma@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
    expect((await agent.post("/api/v1/voice-assessment/sessions").send({})).status).not.toBe(404);
    await setFlag("voice.assessment", false, "usr_a", "Turned off for the test");
    const res = await agent.post("/api/v1/voice-assessment/sessions").send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("FEATURE_DISABLED");
    await setFlag("webhooks.delivery", false, "usr_a", "Turned off for the test");
    expect(await enqueueForEvent({ id: "e1", type: "triage.completed", data: {} } as never)).toBe(0);
  });
});

describe("NFR-072 organisation protocol set", () => {
  const all = () => listClinicalProtocols().map((p) => p.id);

  it("offers every protocol by default", async () => {
    expect(hiddenProtocolIds().size).toBe(0);
    const view = await protocolSetView();
    expect(view).toMatchObject({ offered: all().length, total: all().length });
  });

  it("hides chosen protocols from the list, records who and why, and can be put back", async () => {
    const [first] = all();
    const change = await setProtocolSet([first], "usr_cso", "Not used on board the aircraft");
    expect(change).toMatchObject({ before: [], after: [first], version: 1 });
    expect(hiddenProtocolIds().has(first)).toBe(true);
    await setProtocolSet([], "usr_cso", "Reinstated after review");
    expect(hiddenProtocolIds().size).toBe(0);
  });

  it("refuses a bad request: no reason, unknown protocol, wrong type, hiding too many or all", async () => {
    await expect(setProtocolSet([all()[0]], "u", "")).rejects.toMatchObject({ code: "PROTOCOL_SET_REASON_REQUIRED" });
    await expect(setProtocolSet(["nope"], "u", "Because I said so")).rejects.toMatchObject({ code: "PROTOCOL_SET_UNKNOWN" });
    await expect(setProtocolSet("all", "u", "Because I said so")).rejects.toMatchObject({ code: "PROTOCOL_SET_INVALID" });
    await expect(setProtocolSet(all(), "u", "Because I said so")).rejects.toMatchObject({ code: "PROTOCOL_SET_TOO_MANY_HIDDEN" });
    const tooMany = all().slice(0, Math.floor(all().length / 2) + 1);
    if (tooMany.length < all().length) await expect(setProtocolSet(tooMany, "u", "Because I said so")).rejects.toMatchObject({ code: "PROTOCOL_SET_TOO_MANY_HIDDEN" });
  });

  describe("through the API", () => {
    const app = createApp();
    beforeEach(() => { resetSecurityStoreForTests(); resetRateLimitBucketsForTests(); });

    it("hides from the list and search but not from a direct lookup, and only a clinical governance approver can change it", async () => {
      const target = listClinicalProtocols()[0];
      const nurse = request.agent(app);
      await nurse.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
      await nurse.put("/api/v1/protocols/set").send({ hiddenProtocolIds: [target.id], reason: "Not used on board" }).expect(403);

      const agent = request.agent(app);
      await agent.post("/api/v1/auth/login").send({ username: "rishma@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
      await agent.put("/api/v1/protocols/set").send({ hiddenProtocolIds: [target.id] }).expect(400);
      await agent.put("/api/v1/protocols/set").send({ hiddenProtocolIds: [target.id], reason: "Not used on board" }).expect(200);
      const list = (await agent.get("/api/v1/protocols").expect(200)).body;
      expect(list.protocols.map((p: { id: string }) => p.id)).not.toContain(target.id);
      expect(list.totalCount).toBe(listClinicalProtocols().length - 1);
      const found = (await agent.get("/api/v1/protocols/search").query({ q: target.titleEn, ageYears: 40 }).expect(200)).body.results as Array<{ id: string }>;
      expect(found.map((r) => r.id)).not.toContain(target.id);
      await agent.get(`/api/v1/protocols/${encodeURIComponent(target.id)}`).expect(200);
      expect((await agent.get("/api/v1/protocols/set").expect(200)).body.hiddenProtocolIds).toEqual([target.id]);
    });
  });
});
