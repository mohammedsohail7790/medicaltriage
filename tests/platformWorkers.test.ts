import { readFileSync } from "node:fs";
import path from "node:path";

const startJobWorker = jest.fn();
const processJobs = jest.fn(async () => ({ attempted: 0, succeeded: 0, retried: 0, dead: 0 }));
const startWebhookWorker = jest.fn();
const processDueDeliveries = jest.fn(async () => ({ attempted: 0, delivered: 0, retried: 0, dead: 0 }));
const startSchedulerWorker = jest.fn();
const startTraceExporter = jest.fn();

jest.mock("../src/services/integrationQueue.js", () => ({ startJobWorker: (...a: unknown[]) => startJobWorker(...a), processJobs: () => processJobs(), registerJobHandler: jest.fn() }));
jest.mock("../src/services/webhooks.js", () => ({ startWebhookWorker: (...a: unknown[]) => startWebhookWorker(...a), processDueDeliveries: () => processDueDeliveries(), registerWebhookSubscriber: jest.fn() }));
jest.mock("../src/services/jobScheduler.js", () => ({ ...jest.requireActual("../src/services/jobScheduler.js"), startSchedulerWorker: (...a: unknown[]) => startSchedulerWorker(...a) }));
jest.mock("../src/observability/tracing.js", () => ({ startTraceExporter: (...a: unknown[]) => startTraceExporter(...a) }));
jest.mock("../src/integration/messageBroker.js", () => ({ registerBrokerPublishing: jest.fn() }));
jest.mock("../src/services/eventRules.js", () => ({ registerRuleSubscriber: jest.fn() }));
jest.mock("../src/services/schedulerHandlers.js", () => ({ registerSchedulerHandlers: jest.fn() }));
jest.mock("../src/services/communicationAdapters.js", () => ({ getEmailAdapter: jest.fn() }));

import { drainPlatformQueues, startPlatformWorkers } from "../src/services/platformEvents.js";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

// NFR-130: with an external scheduler the API instances start no background workers, and the scheduler job drains the queues.
describe("platform workers and the external scheduler job", () => {
  beforeEach(() => jest.clearAllMocks());

  it("starts the webhook, job and scheduler workers in the application by default", () => {
    startPlatformWorkers({});
    expect(startWebhookWorker).toHaveBeenCalledTimes(1);
    expect(startJobWorker).toHaveBeenCalledTimes(1);
    expect(startSchedulerWorker).toHaveBeenCalledTimes(1);
    expect(startTraceExporter).toHaveBeenCalledTimes(1);
  });

  it("starts none of them in the application when the scheduler is external, but keeps the trace exporter", () => {
    startPlatformWorkers({ SCHEDULER_MODE: "external" });
    expect(startWebhookWorker).not.toHaveBeenCalled();
    expect(startJobWorker).not.toHaveBeenCalled();
    expect(startSchedulerWorker).not.toHaveBeenCalled();
    expect(startTraceExporter).toHaveBeenCalledTimes(1);
  });

  it("drains queued jobs and webhook deliveries at least once, even with no time budget", async () => {
    const result = await drainPlatformQueues(0, 1);
    expect(result.passes).toBe(1);
    expect(processJobs).toHaveBeenCalledTimes(1);
    expect(processDueDeliveries).toHaveBeenCalledTimes(1);
  });

  it("keeps draining until the time budget is used, and survives a failing pass", async () => {
    processJobs.mockRejectedValueOnce(new Error("database unavailable"));
    const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await drainPlatformQueues(0.25, 50);
    log.mockRestore();
    expect(result.passes).toBeGreaterThan(1);
    expect(processDueDeliveries.mock.calls.length).toBe(result.passes);
  });

  it("is wired in the tenant Terraform: the job and the service use the same KMS key, and no local field key is mounted", () => {
    for (const file of ["terraform/tenant-qatar-airways/run.tf", "terraform/tenant-qatar-airways/jobs.tf"]) {
      const text = read(file);
      // The default is Cloud KMS; with a Fortanix endpoint set, both use the same vault key. Either way the job and the service match.
      expect(text).toMatch(/FIELD_ENCRYPTION_PROVIDER\s+=\s+"gcp-kms"/);
      expect(text).toMatch(/FIELD_ENCRYPTION_KMS_KEY\s+=\s+local\.field_key_id/);
      expect(text).toMatch(/FIELD_ENCRYPTION_PROVIDER\s+=\s+"fortanix"/);
      expect(text).toMatch(/FORTANIX_ENDPOINT\s+=\s+var\.fortanix_endpoint/);
      expect(text).toMatch(/FORTANIX_KEY_ID\s+=\s+var\.fortanix_key_id/);
    }
    const secretsDefault = /variable "secrets"[\s\S]*?default\s+=\s+\[([^\]]*)\]/.exec(read("terraform/tenant-qatar-airways/variables.tf"))?.[1] ?? "";
    expect(secretsDefault).not.toContain("field-encryption-key");
    expect(read("src/schedulerJob.ts")).toContain("drainPlatformQueues");
  });
});
