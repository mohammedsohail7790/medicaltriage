import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { contentPackageReady, listClinicalProtocols } from "../src/services/clinicalContent.js";
import { explainCandidate, loadGuidelineMappings, possibleConditions, sourceInfo } from "../src/services/clinicalExplain.js";
import { resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

const PASSWORD = "TestAdminPassword!2026";
process.env.ADMIN_PASSWORD = PASSWORD;
const app = createApp();

beforeAll(async () => {
  await contentPackageReady;
});
beforeEach(() => {
  resetSecurityStoreForTests();
  resetRateLimitBucketsForTests();
  delete process.env.SYMPTOM_CHECKER_ENABLED;
});

async function nurse() {
  const agent = request.agent(app);
  await agent.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
  return agent;
}

describe("F-006 source references and review information", () => {
  it("reports the release, review status and references for a protocol, and no unconfirmed guideline mapping", () => {
    const protocol = listClinicalProtocols()[0];
    const info = sourceInfo(protocol, []);
    expect(info.release.version).toBeTruthy();
    expect(info.protocolId).toBe(protocol.id);
    expect(info.guidelineMappings).toEqual([]);
    expect(info.guidelineMappingNote).toMatch(/No WHO, NICE or CDC mapping/);
  });

  it("shows a WHO, NICE or CDC mapping only once the clinical team has confirmed it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gm-"));
    const file = path.join(dir, "m.json");
    writeFileSync(file, JSON.stringify([
      { protocolId: "p1", body: "NICE", reference: "NICE guideline NG1", confirmedBy: "Dr Reviewer", confirmedAtIso: "2026-09-01T00:00:00Z" },
      { protocolId: "p1", body: "WHO", reference: "WHO guideline, not yet confirmed" },
      { protocolId: "p1", body: "ISO", reference: "bad body", confirmedBy: "x", confirmedAtIso: "2026-09-01T00:00:00Z" }
    ]));
    const loaded = loadGuidelineMappings(file);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].body).toBe("NICE");
    expect(loadGuidelineMappings(path.join(dir, "missing.json"))).toEqual([]);
  });
});

describe("F-022 / AI-023 explainability", () => {
  it("gives the reasons for a candidate from the search and the questions answered yes", () => {
    const protocol = listClinicalProtocols().find((p) => p.questions.length > 0)!;
    const question = protocol.questions[0];
    const word = protocol.titleEn.split(/\s+/)[0];
    const explanation = explainCandidate(protocol.id, { q: word, ageYears: 30, positiveQuestionIds: [question.id, "not-a-question"] })!;
    expect(explanation.triggeringQuestions.map((q) => q.id)).toEqual([question.id]);
    expect(explanation.reasons.some((r) => r.kind === "patient_fit")).toBe(true);
    expect(explanation.reasons.some((r) => r.kind === "triggering_question")).toBe(true);
    expect(explanation.basis).toMatch(/No model generated/);
    expect(explainCandidate("nope", {})).toBeUndefined();
  });

  it("is served to a nurse, with 404 for an unknown protocol", async () => {
    const agent = await nurse();
    const protocol = listClinicalProtocols()[0];
    const res = await agent.get(`/api/v1/protocols/${encodeURIComponent(protocol.id)}/explain`).query({ q: protocol.titleEn, ageYears: 40 }).expect(200);
    expect(res.body.protocolId).toBe(protocol.id);
    await agent.get(`/api/v1/protocols/${encodeURIComponent(protocol.id)}/source`).expect(200);
    await agent.get("/api/v1/protocols/does-not-exist/explain").expect(404);
    await request(app).get(`/api/v1/protocols/${encodeURIComponent(protocol.id)}/explain`).expect(401);
  });
});

describe("F-009 possible conditions", () => {
  it("is off by default and, when enabled, lists only what the protocol content states", async () => {
    const protocol = listClinicalProtocols()[0];
    expect(possibleConditions(protocol.id).enabled).toBe(false);
    const agent = await nurse();
    expect((await agent.get(`/api/v1/protocols/${encodeURIComponent(protocol.id)}/possible-conditions`).expect(200)).body.enabled).toBe(false);
    process.env.SYMPTOM_CHECKER_ENABLED = "true";
    const on = (await agent.get(`/api/v1/protocols/${encodeURIComponent(protocol.id)}/possible-conditions`).expect(200)).body;
    expect(on.enabled).toBe(true);
    expect(on.conditions[0]).toMatchObject({ name: protocol.titleEn, basis: "Protocol title" });
    expect(on.disclaimer).toMatch(/not a diagnosis/);
    await agent.get("/api/v1/protocols/nope/possible-conditions").expect(404);
  });
});
