// The migration's transforms, on documents shaped like Firestore's REST
// answers. Offline: it proves what each Firestore document becomes, not that
// anything was read or written (the migration itself is never run here).
//
// Run: node tests/test_migrate.mjs
import assert from "node:assert/strict";
import * as t from "../scripts/migrate/transform.mjs";

let checks = 0;
const eq = (a, b, what) => { assert.deepEqual(a, b, what); checks += 1; };

const rest = (path, fields, createTime = "2026-09-01T10:00:00Z") =>
  t.fromRest({ name: `projects/p/databases/(default)/documents/${path}`, fields, createTime });

// ── values ────────────────────────────────────────────────────────────────
const doc = rest("users/fbUid1", {
  credits: { integerValue: "1240" },
  teamName: { stringValue: "Apex" },
  team_name: { stringValue: "Apex Racing" },
  sponsored: { booleanValue: true },
  sponsor_rate: { doubleValue: 0.5 },
  unlimited_until: { timestampValue: "2026-12-01T00:00:00.000000Z" },
  lap_calc_defaults: { mapValue: { fields: { carWeightG: { stringValue: "50" } } } },
  notifications: { arrayValue: { values: [{ mapValue: { fields: { type: { stringValue: "finished" } } } }] } },
  totalSpent: { integerValue: "300" },
});
eq(doc.id, "fbUid1", "the document id");
eq(doc.data.unlimited_until, "2026-12-01T00:00:00.000Z", "timestamps become ISO");
eq(doc.data.lap_calc_defaults, { carWeightG: "50" }, "maps decode, inner keys untouched");

const user = t.userRow(doc, "uuid-1");
eq(user.id, "uuid-1", "the new id");
eq(user.storage_uid, "fbUid1", "files stay under the Firebase uid");
eq(user.legacy_uid, "fbUid1", "the Firebase uid is kept");
eq(user.credits, 1240, "the balance carries over exactly");
eq(user.team_name, "Apex Racing", "the snake_case spelling wins over the camelCase one");
eq(user.sponsor_rate, 0.5, "the sponsor rate carries over");
eq(user.extra, { total_spent: 300 }, "fields with no column are kept in extra");

// ── groups ────────────────────────────────────────────────────────────────
const map = new Map([["fbUid1", "uuid-1"], ["fbUid2", "uuid-2"]]);
const group = t.groupRow(rest("groups/g1", {
  user_id: { stringValue: "fbUid1" },
  name: { stringValue: "Car" },
  shared_with: { mapValue: { fields: { fbUid2: { stringValue: "edit" }, gone: { stringValue: "view" } } } },
  shared_emails: { mapValue: { fields: { fbUid2: { stringValue: "b@x.org" } } } },
}), map);
eq(group.user_id, "uuid-1", "the owner is re-keyed");
eq(group.shared_with, { "uuid-2": "edit" }, "sharing is re-keyed; a deleted account drops out");
eq(group.shared_emails, { "uuid-2": "b@x.org" }, "and the emails with it");
assert.throws(() => t.groupRow(rest("groups/g2", { user_id: { stringValue: "nobody" } }), map), /no account/);
checks += 1;

// ── geometries and versions ───────────────────────────────────────────────
const { geometry, versions } = t.geometryRows(rest("geometries/geo1", {
  user_id: { stringValue: "fbUid1" },
  group_id: { stringValue: "g1" },
  current_version: { integerValue: "2" },
  versions: { mapValue: { fields: {
    1: { mapValue: { fields: { kind: { stringValue: "raw" }, step_path: { stringValue: "users/fbUid1/geometries/geo1/v1/geometry.step" } } } },
    2: { mapValue: { fields: { kind: { stringValue: "flow_domain" }, at: { timestampValue: "2026-09-02T00:00:00Z" } } } },
  } } },
}), map, new Set(["g1"]));
eq(geometry.current_version, 2, "the current version");
eq(versions.length, 2, "one version row per version");
eq(versions[0].data.step_path, "users/fbUid1/geometries/geo1/v1/geometry.step", "paths are unchanged");
eq(versions[1].data.at, "2026-09-02T00:00:00.000Z", "timestamps inside a version decode too");
eq(t.geometryRows(rest("geometries/geo2", { user_id: { stringValue: "fbUid1" }, group_id: { stringValue: "deleted" } }),
  map, new Set()).geometry.group_id, null, "a group that no longer exists is not pointed at");

// ── jobs: the Fusion add-in's camelCase, and statuses ─────────────────────
const job = t.jobRow(rest("jobs/j1", {
  userId: { stringValue: "fbUid1" },
  status: { stringValue: "complete" },
  stepPath: { stringValue: "jobs/j1/geometry.step" },
  drag_N: { doubleValue: 0.42 },
  cost: { integerValue: "150" },
  run_id: { stringValue: "simscale-run" },
}), map);
eq(job.user_id, "uuid-1", "a camelCase owner is found");
eq(job.step_path, "jobs/j1/geometry.step", "camelCase fields fold to snake_case");
eq(job.drag_n, 0.42, "drag_N becomes drag_n");
eq(job.simscale_run_id, "simscale-run", "SimScale's run id has its own column");
eq(job.next_poll_at, null, "an imported job is never scheduled");
const old = t.jobRow(rest("jobs/j2", { user_id: { stringValue: "fbUid1" }, status: { stringValue: "queued" } }), map);
eq(old.status, "failed", "a status the pipeline no longer has reads as failed");
eq(old.extra.legacy_status, "queued", "and the original is kept");

// ── the ledger ────────────────────────────────────────────────────────────
const tx = t.transactionRow(rest("users/fbUid1/transactions/charge_j1", {
  type: { stringValue: "simulation_charge" }, amount: { integerValue: "-150" }, job_id: { stringValue: "j1" },
  timestamp: { timestampValue: "2026-09-03T00:00:00Z" },
}), map);
eq([tx.user_id, tx.id, tx.amount, tx.job_id], ["uuid-1", "charge_j1", -150, "j1"],
  "a ledger row keeps its deterministic id, so refunds still find the charge");
eq(t.TRANSACTION_TYPES.includes("usage"), false, "the old client-written 'usage' rows are not a ledger type");

// ── storage ───────────────────────────────────────────────────────────────
eq(t.md5Hex("1B2M2Y8AsgTpgAmY7PhCfg=="), "d41d8cd98f00b204e9800998ecf8427e", "GCS's md5 as Storage's ETag hex");
eq(t.shouldCopy("users/fbUid1/geometries/geo1/raw.step"), true, "user files are copied");
eq(t.shouldCopy("jobs/j1/geometry.step"), true, "the add-in's job files are copied");
eq(t.shouldCopy("results/j1/old.vtp"), false, "the old unreachable results folder is not");

console.log(`migrate: ${checks} checks, Firestore documents become the right rows`);
