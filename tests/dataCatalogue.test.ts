import { Prisma } from "@prisma/client";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetRateLimitBucketsForTests } from "../src/middleware/rateLimit.js";
import { buildDataCatalogue, classifyField, dataCatalogueCsv, unreviewedSensitiveFields } from "../src/services/dataCatalogue.js";
import { ENCRYPTED_FIELDS } from "../src/services/fieldEncryption.js";
import { resetSecurityStoreForTests } from "../src/services/securityAdmin.js";

process.env.ADMIN_PASSWORD = "TestAdminPassword!2026";
const app = createApp();

describe("AI-016 data catalogue and classification", () => {
  const catalogue = buildDataCatalogue();

  it("lists every table and every column of the schema", () => {
    const models = Prisma.dmmf.datamodel.models;
    expect(catalogue.tables).toHaveLength(models.length);
    for (const model of models) {
      const table = catalogue.tables.find((t) => t.entity === model.name)!;
      expect(table.table).toBe(model.dbName ?? model.name);
      expect(table.fields.map((f) => f.name).sort()).toEqual(model.fields.filter((f) => f.kind !== "object").map((f) => f.name).sort());
    }
  });

  it("labels every field with one of the defined classes", () => {
    const classes = new Set(["credential", "clinical", "personal", "security", "operational", "reference"]);
    for (const table of catalogue.tables) for (const field of table.fields) expect(classes.has(field.classification)).toBe(true);
  });

  it("tags personal and clinical fields, and flags what is encrypted at rest", () => {
    const field = (entity: string, name: string) => catalogue.tables.find((t) => t.entity === entity)!.fields.find((f) => f.name === name)!;
    expect(field("Dependent", "fullName")).toMatchObject({ classification: "personal", encrypted: true });
    expect(field("TriageQueueItem", "vitals")).toMatchObject({ classification: "clinical", encrypted: true });
    expect(field("TriageQueueItem", "summary").classification).toBe("clinical");
    expect(field("ApplicationUser", "passwordHash").classification).toBe("credential");
    expect(field("ApplicationUser", "emailCiphertext")).toMatchObject({ classification: "credential", encrypted: true });
    expect(field("AuditEvent", "ipAddress").classification).toBe("security");
    expect(catalogue.tables.find((t) => t.entity === "TriageQueueItem")).toMatchObject({ containsClinicalData: true, containsPersonalData: true });
  });

  it("marks every column that is encrypted at rest as such", () => {
    for (const [entity, fields] of Object.entries(ENCRYPTED_FIELDS)) {
      for (const name of Object.keys(fields)) {
        expect(catalogue.tables.find((t) => t.entity === entity)!.fields.find((f) => f.name === name)!.encrypted).toBe(true);
      }
    }
  });

  it("does not let a field that looks sensitive pass without a decision (fails when the schema grows)", () => {
    expect(unreviewedSensitiveFields()).toEqual([]);
  });

  it("classifies by name pattern when there is no explicit decision", () => {
    expect(classifyField("Anything", "recipientEmail").classification).toBe("personal");
    expect(classifyField("Anything", "accessToken").classification).toBe("credential");
    expect(classifyField("Anything", "createdAt").classification).toBe("operational");
  });

  it("produces a flat file with one row per field", () => {
    const csv = dataCatalogueCsv(catalogue);
    const total = catalogue.tables.reduce((n, t) => n + t.fields.length, 0);
    expect(csv.split("\n")).toHaveLength(total + 1);
    expect(csv.split("\n")[0]).toBe("table,entity,table_classification,column,field,type,nullable,classification,encrypted_at_rest");
  });

  describe("over the API", () => {
    beforeEach(() => {
      resetSecurityStoreForTests();
      resetRateLimitBucketsForTests();
    });
    const asAdmin = async () => {
      const agent = request.agent(app);
      await agent.post("/api/v1/auth/login").send({ username: "rishma@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "platform_super_administrator" }).expect(200);
      return agent;
    };

    it("serves JSON and CSV to someone who may view audit information", async () => {
      const admin = await asAdmin();
      const json = await admin.get("/api/v1/admin/data-catalogue").expect(200);
      expect(json.body.tables.length).toBe(catalogue.tables.length);
      const csv = await admin.get("/api/v1/admin/data-catalogue?format=csv").expect(200);
      expect(csv.headers["content-type"]).toMatch(/text\/csv/);
      expect(csv.text.split("\n")[0]).toContain("classification");
    });

    it("refuses someone who may not", async () => {
      const nurse = request.agent(app);
      await nurse.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
      await nurse.get("/api/v1/admin/data-catalogue").expect(403);
      await request(app).get("/api/v1/admin/data-catalogue").expect(401);
    });
  });
});
