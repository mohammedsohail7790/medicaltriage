// NFR-129 / NFR-120 / M-027: how the database queries behind the busiest screens behave as data grows. Builds a scratch
// database with the real schema, fills it with synthetic cases and audit events at each volume, and times the queries the
// queue board, the case list and the audit trail run (EXPLAIN ANALYZE, so the figure is the database's own execution time),
// noting whether an index was used. It never touches the source database.
//   DATABASE_URL=... node scripts/dataGrowthTest.mjs [--volumes 10000,100000,500000]
import { execFileSync } from "node:child_process";

const source = new URL(process.env.DATABASE_URL ?? "");
const sourceDb = source.pathname.slice(1);
const scratch = `${sourceDb}_growth`;
const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const volumes = arg("volumes", "10000,100000,500000").split(",").map(Number);
const plain = (db) => { const u = new URL(source.toString()); u.pathname = `/${db}`; u.search = ""; return u.toString(); };
const psql = (db, sql) => execFileSync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", plain(db), "-c", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

const QUERIES = {
  "open queue board (ranked, 50 rows)": `select * from triage_queue_items where deleted_at is null and status in ('INCOMING','IN_PROCESS','INFO_REQUIRED') order by priority_score desc, sla_deadline asc limit 50`,
  "completed cases for one organisation (page of 50)": `select * from triage_queue_items where organization_id = 'org-1' and status = 'COMPLETED' and deleted_at is null order by updated_at desc limit 50`,
  "one nurse's open cases": `select * from triage_queue_items where assigned_nurse_id = 'nurse-7' and status = 'IN_PROCESS'`,
  "one employee's case history": `select * from triage_queue_items where ist_staff_id = 'IST-1042' order by created_at desc limit 20`,
  "audit trail, newest 200": `select * from audit_events order by timestamp desc limit 200`,
  "audit trail for one user (200)": `select * from audit_events where user_id = 'usr-12' order by timestamp desc limit 200`
};

const exec = (db, sql) => {
  const out = psql(db, `explain (analyze, format json) ${sql}`);
  const plan = JSON.parse(out)[0];
  const text = JSON.stringify(plan.Plan);
  return { ms: Math.round(plan["Execution Time"] * 100) / 100, scan: /"Node Type":"Seq Scan"/.test(text) ? "sequential scan" : "index" };
};

const results = [];
try {
  psql("postgres", `drop database if exists "${scratch}"`);
  psql("postgres", `create database "${scratch}"`);
  const schema = execFileSync("pg_dump", ["-s", "--no-owner", "--no-privileges", plain(sourceDb)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", plain(scratch)], { input: schema, stdio: ["pipe", "ignore", "pipe"] });
  // The scratch copy's audit chain triggers would reject synthetic rows; they are switched off here only, never on the source.
  psql(scratch, `alter table audit_events disable trigger user`);
  psql(scratch, `insert into organizations (id, name, code, updated_at) values ('org-1','Org 1','O1',now()),('org-2','Org 2','O2',now()),('org-3','Org 3','O3',now())`);
  psql(scratch, `insert into staff_members (id, ist_staff_id, department, job_title, updated_at) values ('s1','IST-1042','Cabin crew','Cabin crew', now())`);
  let have = 0;
  for (const volume of volumes) {
    const add = volume - have;
    psql(scratch, `
      insert into triage_queue_items (id, ist_staff_id, staff_member_id, organization_id, status, current_stage, priority_score, department, summary, sla_deadline, assigned_nurse_id, created_at, updated_at)
      select 'c' || g, 'IST-' || (1000 + g % 5000), case when g % 5000 = 42 then 's1' end, 'org-' || (1 + g % 3),
             (case g % 10 when 0 then 'INCOMING' when 1 then 'IN_PROCESS' else 'COMPLETED' end)::"QueueStatus",
             'INTAKE'::"QueueClinicalStage", (g * 7) % 12000, 'Dept ' || (g % 20), 'synthetic case ' || g,
             now() + (g % 90 || ' minutes')::interval, 'nurse-' || (g % 40), now() - (g % 400 || ' hours')::interval, now() - (g % 400 || ' hours')::interval
      from generate_series(${have + 1}, ${volume}) g`);
    psql(scratch, `
      insert into audit_events (id, sequence_number, timestamp, user_id, active_role, organization, facility, department, action, module, resource, ip_address, device, success, risk_level, event_hash, previous_hash, key_version)
      select 'a' || g, g, now() - (g || ' seconds')::interval, 'usr-' || (g % 60), 'remote_triage_nurse', 'org', '', '', 'QUEUE_ITEM_MOVE', 'Queue', 'TriageQueueItem', '', '', true, 'low', 'h' || g, 'h' || (g - 1), 'v1'
      from generate_series(${have + 1}, ${volume}) g` ).toString();
    psql(scratch, "analyze");
    have = volume;
    const timings = {};
    for (const [name, sql] of Object.entries(QUERIES)) {
      const runs = Array.from({ length: 5 }, () => exec(scratch, sql));
      const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
      timings[name] = { p50Ms: ms[2], worstMs: ms[4], plan: runs[0].scan };
    }
    results.push({ queueCases: volume, auditEvents: volume, timings });
  }
  console.log(JSON.stringify({ note: "Database execution time on this machine for the queries behind the busiest screens, at each data volume. Application and network time are extra. Repeat in the tenant with Qatar Airways' growth assumptions.", results }, null, 2));
} finally {
  try { psql("postgres", `drop database if exists "${scratch}"`); } catch { /* best effort */ }
}
