// NFR-154: measures the size on the wire (gzip, as the server sends it) of the responses a nurse's screen asks for, and
// prints the per-user network estimate for a projection. `pnpm network:estimate -- --nurses 80 --poll 10`.
import { gzipSync } from "node:zlib";
import request from "supertest";
import { createApp } from "../src/app.js";
import { DEFAULT_PROJECTION, estimate, type Projection } from "../src/utils/networkEstimate.js";

process.env.MOCK_MODE ??= "true";
process.env.ADMIN_PASSWORD ??= "TestAdminPassword!2026";
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};

const agent = request.agent(createApp());
await agent.post("/api/v1/auth/login").send({ username: "layla@irisstar.tech", password: process.env.ADMIN_PASSWORD, simulateRole: "remote_triage_nurse" }).expect(200);
const wire = (body: unknown) => gzipSync(Buffer.from(typeof body === "string" ? body : JSON.stringify(body))).length;

const list = await agent.get("/api/v1/queue");
const first = list.body.queue[0].id as string;
const one = await agent.get(`/api/v1/queue/${first}`);
const session = await agent.get("/api/v1/auth/session");
const note = await agent.post("/api/v1/triage/preview").send({ chief_complaint: "Synthetic", final_disposition_code: "HMC_URGENT_CARE", routing_destination: "Synthetic" });
const slim = await agent.get("/api/v1/queue").set("Save-Data", "on");

const measured = { queueListBytes: wire(list.body), caseBytes: wire(one.body), noteBytes: wire(note.body), sessionBytes: wire(session.body) };
const projection: Projection = { ...DEFAULT_PROJECTION, concurrentNurses: arg("nurses", DEFAULT_PROJECTION.concurrentNurses), managerBoards: arg("boards", DEFAULT_PROJECTION.managerBoards), pollSeconds: arg("poll", DEFAULT_PROJECTION.pollSeconds) };
console.log(JSON.stringify({ measuredBytesOnTheWire: measured, lowBandwidthQueueListBytes: wire(slim.body), queueItemsInMeasurement: list.body.queue.length, projection, estimate: estimate(measured, projection) }, null, 2));
process.exit(0);
