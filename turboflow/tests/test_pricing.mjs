// The browser's pricing copy must agree with the server's, exactly.
//
// Build spec section 15 step 1. src/lib/pricing.js quotes the price on the
// Queue button; functions/src/lib/pricing.ts charges the account. If they ever
// disagree the user is told one number and billed another, and nobody finds
// out until a support message. So both are run against the same inputs here,
// including the ones that break naive implementations: strings, nulls, NaN,
// values past the clamps, and the exact refinement levels whose fineness the
// old backend used to interpolate wrongly.
//
// Run: node tests/test_pricing.mjs   (after npm run build:functions)

import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const client = await import(pathToFileURL(join(root, "src/lib/pricing.js")).href);

const serverPath = join(root, "functions/lib/lib/pricing.js");
if (!existsSync(serverPath)) {
  console.error(`Compiled server pricing not found at ${serverPath}.`);
  console.error("Run: npm run build:functions");
  process.exit(1);
}
const server = await import(pathToFileURL(serverPath).href);

let checks = 0;
const failures = [];

function same(what, a, b) {
  checks++;
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) failures.push(`${what}\n     client ${x}\n     server ${y}`);
}

// ── clampRunParams over everything a client could send ──────────────────────
const RAW = [
  {},
  { refine_level: 1, iteration_count: 1000 },
  { refine_level: 2, iteration_count: 1000 },
  { refine_level: 3, iteration_count: 1000 },
  { refine_level: 4, iteration_count: 1000 },
  { refine_level: 5, iteration_count: 1000 },
  { refine_level: 5, iteration_count: 3000, inlet_velocity: 100 },
  { refine_level: 3, iteration_count: 1, inlet_velocity: 1 },
  // past the clamps, both ways
  { refine_level: 0, iteration_count: 0, inlet_velocity: 0 },
  { refine_level: 99, iteration_count: 999999, inlet_velocity: 1e9 },
  { refine_level: -5, iteration_count: -100, inlet_velocity: -20 },
  // the shapes that make a naive parseInt produce NaN
  { refine_level: "3", iteration_count: "1500", inlet_velocity: "25.5" },
  { refine_level: "1e", iteration_count: "abc", inlet_velocity: "" },
  { refine_level: null, iteration_count: undefined, inlet_velocity: NaN },
  { refine_level: 2.4, iteration_count: 1000.6, inlet_velocity: 20.4 },
  // debug meshes are priced as a token amount, not as a run
  { debug_mesh: true, refine_level: 5, iteration_count: 3000 },
  { debug_mesh: "true", refine_level: 5, iteration_count: 3000 },
  { debug_mesh: 1, refine_level: 5, iteration_count: 3000 },
];

for (const raw of RAW) {
  const label = JSON.stringify(raw);
  const a = client.clampRunParams(raw);
  const b = server.clampRunParams(raw);
  same(`clampRunParams(${label})`, a, b);
  same(`listPrice(${label})`, client.listPrice(a), server.listPrice(b));
}

// ── fineness ladder, which must not be interpolated ─────────────────────────
for (const level of [1, 2, 3, 4, 5]) {
  same(`FINENESS[${level}]`, client.FINENESS[level], server.FINENESS[level]);
  const f = client.FINENESS[level];
  checks++;
  if (Math.abs(f * 10 - Math.round(f * 10)) > 1e-9) {
    failures.push(`FINENESS[${level}] = ${f} is not a multiple of 0.1, SimScale rejects it`);
  }
}

// ── chargeFor across account states ─────────────────────────────────────────
const NOW = 1_700_000_000_000;
const USERS = [
  undefined,
  {},
  { sponsored: false },
  { sponsored: true },
  { sponsored: true, sponsor_rate: 0.5 },
  { sponsored: true, sponsor_rate: 0.01 },
  { sponsored: true, sponsor_rate: 0 },
  { sponsored: true, sponsor_rate: 1.5 },
  { sponsored: true, sponsor_rate: "0.25" },
  { unlimited_until: NOW + 86_400_000 },
  { unlimited_until: NOW - 1 },
  { unlimited_until: { toMillis: () => NOW + 1000 } },
  { unlimited_until: { toMillis: () => NOW - 1000 } },
  { sponsored: true, sponsor_rate: 0.5, unlimited_until: NOW + 1000 },
];

for (const user of USERS) {
  for (const raw of RAW.slice(0, 8)) {
    const p = client.clampRunParams(raw);
    const label = `chargeFor(${JSON.stringify(user)}, lvl ${p.refine_level} x ${p.iteration_count})`;
    same(label, client.chargeFor(user, p, NOW), server.chargeFor(user, p, NOW));
  }
  same(`sponsorRate(${JSON.stringify(user)})`, client.sponsorRate(user), server.sponsorRate(user));
  same(`hasUnlimited(${JSON.stringify(user)})`, client.hasUnlimited(user, NOW), server.hasUnlimited(user, NOW));
}

// ── the floor: a sponsored run is discounted, never free ────────────────────
{
  const p = client.clampRunParams({ refine_level: 1, iteration_count: 1 });
  const cost = client.chargeFor({ sponsored: true, sponsor_rate: 0.01 }, p, NOW);
  checks++;
  if (cost < 1) failures.push(`a sponsored run cost ${cost}; only an unlimited pass is free`);
}

// ── the pass is free, and that is the only way to be free ───────────────────
{
  const p = client.clampRunParams({ refine_level: 5, iteration_count: 3000 });
  checks++;
  if (client.chargeFor({ unlimited_until: NOW + 1000 }, p, NOW) !== 0) {
    failures.push("an unlimited pass did not make the run free");
  }
}

// ── fineness back to a refinement level ────────────────────────────────────
// The Queue dialog quotes on this and queueRun charges on it. It was the one
// step of the price each side worked out separately with nothing comparing
// them, because the server's copy lives in jobs/queueRun.ts rather than in
// lib/pricing.ts. Compared here against the server's own function.
{
  const serverQueue = await import(
    pathToFileURL(join(root, "functions/lib/jobs/queueRun.js")).href);
  const values = [
    -5, 0, 0.5, 1, 3, 4, 8, 8.9, 9, 9.0000000001, 9.1, 9.2, 9.3, 9.5,
    9.6, 9.7, 9.8, 9.9, 10, 10.0000001, 11, 99,
  ];
  for (const f of values) {
    same(`levelForFineness(${f})`,
         client.levelForFineness(f), serverQueue.levelForFineness(f));
  }
}

if (failures.length) {
  console.error(`\npricing: ${failures.length} of ${checks} checks FAILED\n`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`pricing: ${checks} checks, client and server agree`);
