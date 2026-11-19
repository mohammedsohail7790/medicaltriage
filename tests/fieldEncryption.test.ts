import { Prisma, type PrismaClient } from "@prisma/client";
import { resetSecretProvider } from "../src/config/secrets.js";
import {
  decryptResult,
  decryptText,
  encryptText,
  encryptWriteData,
  ENCRYPTED_FIELDS,
  FieldEncryptionError,
  fieldEncryptionEnabled,
  isEncryptedValue,
  rewrapEncryptedValue,
  withFieldEncryption
} from "../src/services/fieldEncryption.js";
import { resetKeyProvider, setKeyProvider, type KeyProvider } from "../src/services/keyProvider.js";
import { randomBytes } from "node:crypto";

const KEY_A = "field-key-A-0123456789abcdef0123456789";
const KEY_B = "field-key-B-0123456789abcdef0123456789";

describe("M-019/M-020 field-level encryption", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.FIELD_ENCRYPTION_KEY = KEY_A;
    delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
    resetKeyProvider();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    resetSecretProvider();
    resetKeyProvider();
  });

  describe("envelope encryption", () => {
    it("round-trips text and hides the plaintext", async () => {
      const secret = "Patient reports crushing chest pain since 09:40";
      const stored = await encryptText(secret, "TriageQueueItem.summary");
      expect(isEncryptedValue(stored)).toBe(true);
      expect(stored).not.toContain("chest");
      expect(await decryptText(stored, "TriageQueueItem.summary")).toBe(secret);
    });

    it("uses a fresh data key and nonce for every value", async () => {
      const a = await encryptText("same", "X.y");
      const b = await encryptText("same", "X.y");
      expect(a).not.toBe(b);
    });

    it("handles empty and non-latin text", async () => {
      expect(await decryptText(await encryptText("", "X.y"), "X.y")).toBe("");
      expect(await decryptText(await encryptText("مريض يشكو من ألم", "X.y"), "X.y")).toBe("مريض يشكو من ألم");
    });

    it("rejects a ciphertext moved into a different column", async () => {
      const stored = await encryptText("secret value", "TriageQueueItem.summary");
      await expect(decryptText(stored, "Dependent.fullName")).rejects.toThrow(FieldEncryptionError);
    });

    it("rejects tampering and never leaks the plaintext in the error", async () => {
      const stored = await encryptText("very private note", "X.y");
      const segments = stored.split(":");
      segments[6] = Buffer.from("tampered-bytes").toString("base64url");
      const error = await decryptText(segments.join(":"), "X.y").catch((e: Error) => e);
      expect(error).toBeInstanceOf(FieldEncryptionError);
      expect((error as Error).message).not.toMatch(/private/);
    });

    it("rejects malformed values", async () => {
      await expect(decryptText("enc:v1:onlythree", "X.y")).rejects.toThrow(FieldEncryptionError);
    });
  });

  describe("keys and rotation", () => {
    it("decrypts after rotation using the previous key, and re-wraps without touching the data", async () => {
      const stored = await encryptText("kept across rotation", "X.y");
      process.env.FIELD_ENCRYPTION_KEY = KEY_B;
      process.env.FIELD_ENCRYPTION_KEY_PREVIOUS = KEY_A;
      expect(await decryptText(stored, "X.y")).toBe("kept across rotation");

      const rewrapped = await rewrapEncryptedValue(stored, "X.y");
      expect(rewrapped.changed).toBe(true);
      expect(rewrapped.value.split(":")[2]).not.toBe(stored.split(":")[2]);
      expect(rewrapped.value.split(":").slice(4)).toEqual(stored.split(":").slice(4));

      delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
      await expect(decryptText(stored, "X.y")).rejects.toThrow(FieldEncryptionError);
      expect(await decryptText(rewrapped.value, "X.y")).toBe("kept across rotation");
      expect((await rewrapEncryptedValue(rewrapped.value, "X.y")).changed).toBe(false);
    });

    it("works with a vault-style provider that never exposes key material to the app", async () => {
      const kek = randomBytes(32);
      const calls = { wrap: 0, unwrap: 0 };
      const vault: KeyProvider = {
        activeKeyId: () => "qr-vault-key-1",
        async wrapKey(dataKey) {
          calls.wrap += 1;
          return { keyId: "qr-vault-key-1", wrapped: Buffer.from(dataKey.map((byte, i) => byte ^ kek[i])).toString("base64url") };
        },
        async unwrapKey(keyId, wrapped) {
          calls.unwrap += 1;
          expect(keyId).toBe("qr-vault-key-1");
          return Buffer.from(Buffer.from(wrapped, "base64url").map((byte, i) => byte ^ kek[i]));
        }
      };
      delete process.env.FIELD_ENCRYPTION_KEY;
      setKeyProvider(vault);
      const stored = await encryptText("vault protected", "X.y");
      expect(stored.split(":")[2]).toBe("qr-vault-key-1");
      expect(await decryptText(stored, "X.y")).toBe("vault protected");
      expect(calls).toEqual({ wrap: 1, unwrap: 1 });
    });
  });

  describe("write and read walkers", () => {
    it("encrypts only the configured fields of a queue item", async () => {
      const data = (await encryptWriteData("TriageQueueItem", {
        istStaffId: "IST-1",
        status: "INCOMING",
        summary: "chest pain",
        vitals: { heartRate: 120 },
        queuePayload: { reasonNarrative: "private story" },
        clinicalApproval: null
      })) as Record<string, unknown>;
      expect(data.istStaffId).toBe("IST-1");
      expect(data.status).toBe("INCOMING");
      expect(isEncryptedValue(data.summary)).toBe(true);
      expect(isEncryptedValue(data.vitals)).toBe(true);
      expect(isEncryptedValue(data.queuePayload)).toBe(true);
      expect(data.clinicalApproval).toBeNull();
      expect(JSON.stringify(data)).not.toMatch(/chest pain|private story|120/);
    });

    it("leaves database null markers and undefined values alone", async () => {
      const data = (await encryptWriteData("TriageQueueItem", { vitals: Prisma.JsonNull, summary: undefined })) as Record<string, unknown>;
      expect(data.vitals).toBe(Prisma.JsonNull);
      expect(data.summary).toBeUndefined();
    });

    it("encrypts inside nested relation writes", async () => {
      const data = (await encryptWriteData("StaffMember", {
        istStaffId: "IST-9",
        dependents: { create: [{ fullName: "Child One", relationshipType: "Child" }, { fullName: "Child Two", relationshipType: "Child" }] }
      })) as { dependents: { create: Array<{ fullName: string; relationshipType: string }> } };
      expect(data.dependents.create.every((d) => isEncryptedValue(d.fullName))).toBe(true);
      expect(data.dependents.create[0].relationshipType).toBe("Child");
      expect(await decryptText(data.dependents.create[1].fullName, "Dependent.fullName")).toBe("Child Two");
    });

    it("handles update { set } and upsert-shaped nested writes", async () => {
      const data = (await encryptWriteData("Dependent", { fullName: { set: "Renamed" } })) as { fullName: { set: string } };
      expect(isEncryptedValue(data.fullName.set)).toBe(true);
      const nested = (await encryptWriteData("AviationTriageEncounter", {
        safetyLog: { upsert: { create: { nurseOverrideRationale: "because" }, update: { nurseOverrideRationale: "because again" } } }
      })) as { safetyLog: { upsert: { create: Record<string, string>; update: Record<string, string> } } };
      expect(isEncryptedValue(nested.safetyLog.upsert.create.nurseOverrideRationale)).toBe(true);
      expect(isEncryptedValue(nested.safetyLog.upsert.update.nurseOverrideRationale)).toBe(true);
    });

    it("does not encrypt a value twice", async () => {
      const once = (await encryptWriteData("Dependent", { fullName: "Name" })) as { fullName: string };
      const twice = (await encryptWriteData("Dependent", { fullName: once.fullName })) as { fullName: string };
      expect(twice.fullName).toBe(once.fullName);
    });

    it("decrypts rows, lists and included relations, and passes legacy plaintext through", async () => {
      const row = {
        id: "q1",
        summary: await encryptText("note", "TriageQueueItem.summary"),
        vitals: await encryptText(JSON.stringify({ heartRate: 88 }), "TriageQueueItem.vitals"),
        queuePayload: { legacy: "plaintext json" },
        dependent: { fullName: await encryptText("Child One", "Dependent.fullName") }
      };
      const out = (await decryptResult("TriageQueueItem", [row, { ...row }])) as Array<typeof row>;
      expect(out[0].summary).toBe("note");
      expect(out[0].vitals).toEqual({ heartRate: 88 });
      expect(out[0].queuePayload).toEqual({ legacy: "plaintext json" });
      expect(out[1].dependent.fullName).toBe("Child One");
    });

    it("fails closed when a stored value cannot be decrypted", async () => {
      const stored = await encryptText("note", "TriageQueueItem.summary");
      process.env.FIELD_ENCRYPTION_KEY = KEY_B;
      await expect(decryptResult("TriageQueueItem", { summary: stored })).rejects.toThrow(FieldEncryptionError);
    });

    it("only lists real, non-filtered text and JSON columns", () => {
      for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
        const meta = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
        expect(meta).toBeDefined();
        for (const [field, kind] of Object.entries(fields)) {
          const column = meta!.fields.find((f) => f.name === field);
          expect(column?.type).toBe(kind === "json" ? "Json" : "String");
        }
      }
    });
  });

  describe("prisma extension", () => {
    function hook() {
      let config: any;
      const fake = { $extends: (c: unknown) => { config = c; return fake; } } as unknown as PrismaClient;
      withFieldEncryption(fake);
      return config.query.$allModels.$allOperations as (args: { model: string; operation: string; args: any; query: (a: any) => Promise<any> }) => Promise<any>;
    }

    it("encrypts what is sent to the database and returns plaintext to the caller", async () => {
      const run = hook();
      let sent: any;
      const result = await run({
        model: "TriageQueueItem",
        operation: "create",
        args: { data: { istStaffId: "IST-1", summary: "chest pain" } },
        query: async (a) => {
          sent = a;
          return { id: "q1", ...a.data };
        }
      });
      expect(isEncryptedValue(sent.data.summary)).toBe(true);
      expect(sent.data.summary).not.toContain("chest");
      expect(result.summary).toBe("chest pain");
    });

    it("encrypts both sides of an upsert and leaves reads unchanged", async () => {
      const run = hook();
      let sent: any;
      await run({
        model: "Dependent",
        operation: "upsert",
        args: { where: { id: "d1" }, create: { fullName: "A" }, update: { fullName: "B" } },
        query: async (a) => {
          sent = a;
          return {};
        }
      });
      expect(isEncryptedValue(sent.create.fullName)).toBe(true);
      expect(isEncryptedValue(sent.update.fullName)).toBe(true);
      const read = await run({
        model: "Dependent",
        operation: "findMany",
        args: { where: { staffMemberId: "s1" } },
        query: async (a) => {
          expect(a).toEqual({ where: { staffMemberId: "s1" } });
          return [{ id: "d1", fullName: await encryptText("A", "Dependent.fullName") }];
        }
      });
      expect(read[0].fullName).toBe("A");
    });
  });

  describe("configuration", () => {
    it("is always on in production and cannot be switched off there", () => {
      expect(fieldEncryptionEnabled({ NODE_ENV: "production" })).toBe(true);
      expect(() => fieldEncryptionEnabled({ NODE_ENV: "production", FIELD_ENCRYPTION_ENABLED: "false" })).toThrow(/not allowed in production/);
    });

    it("is opt-in elsewhere", () => {
      expect(fieldEncryptionEnabled({ NODE_ENV: "test" })).toBe(false);
      expect(fieldEncryptionEnabled({ NODE_ENV: "development", FIELD_ENCRYPTION_ENABLED: "true" })).toBe(true);
    });
  });
});
