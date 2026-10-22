// What a run costs. The browser's copy.
//
// This is the same arithmetic as functions/src/lib/pricing.ts, which is the
// authority: the server clamps and charges, the browser only quotes. They must
// agree exactly, because the number on the Queue button is the number taken
// off the account, and the first anyone notices a drift is a support message.
//
// tests/test_pricing.mjs runs both against the same inputs and fails if any
// answer differs. That test is the reason this file is allowed to exist as a
// copy rather than an import: the server's copy lives with the edge functions
// (supabase/functions/_shared/logic/pricing.ts), which the site does not bundle.

/**
 * Simmetrix fineness per refinement level.
 *
 * Not interpolated. The old backend used 9.0 + (level - 1) * 0.25, which gives
 * 9.25 and 9.75 at levels 2 and 4: values the worker never meshes with, and
 * which SimScale rejects outright because fineness must be a multiple of 0.1.
 */
export const FINENESS = Object.freeze({ 1: 9.0, 2: 9.2, 3: 9.5, 4: 9.7, 5: 10.0 });

/**
 * The five rungs, in words, for the dropdowns.
 *
 * Built from FINENESS rather than typed out again, because the panel used to
 * offer 1, 3, 5, 7 and 9 on the reasoning that SimScale's scale runs 0 to 10.
 * It does, but a car of this size is only ever meshed in the top tenth of it:
 * every rung the product actually prices is between 9.0 and 10.0, so four of
 * those five choices priced as the cheapest level and meshed far coarser than
 * any run the Fusion add-in has ever produced. A control whose settings are
 * not the settings that get used is worse than no control.
 */
export const FINENESS_STEPS = Object.freeze([
  // Below the priced ladder, and deliberately so.
  //
  // A real car at 9.5 in the standard tunnel got 32% through meshing and died
  // with "the machine ran out of memory". A bigger mesher is the first answer
  // and a coarser mesh is the second, and until this existed the second was
  // not reachable from the sidebar at all: the lowest setting was 9.0, which
  // is barely coarser than the one that failed. These two are for getting a
  // run through at all, not for an answer anyone should quote.
  //
  // They price as level 1, the cheapest rung, because the ladder starts at 9.0
  // and there is nothing below it. That undercharges rather than overcharges.
  [7.0, "Very coarse (draft)"],
  [8.0, "Coarse draft"],
  [FINENESS[1], "Coarse"],
  [FINENESS[2], "Moderate"],
  [FINENESS[3], "Standard"],
  [FINENESS[4], "Fine"],
  [FINENESS[5], "Very fine"],
]);

/**
 * SimScale's 0 to 10 fineness back to the 1 to 5 level a run is priced on.
 *
 * The Queue dialog had its own copy of this rule inlined in App.jsx. It gave
 * the same answers, but it was the one step of the price the client and the
 * server each worked out separately and nothing compared: the two could have
 * drifted and the first sign would have been a user quoted 25 and charged 40.
 * Mirrors levelForFineness in functions/src/jobs/queueRun.ts, and
 * tests/test_pricing.mjs now runs both.
 */
export function levelForFineness(fineness) {
  const rungs = Object.entries(FINENESS)
    .map(([level, f]) => ({ level: Number(level), f: Number(f) }))
    .sort((a, b) => a.f - b.f);
  const hit = rungs.find((r) => fineness <= r.f + 1e-9);
  return hit ? hit.level : (rungs[rungs.length - 1]?.level ?? 3);
}

export const LIMITS = Object.freeze({
  iterations: { min: 1, max: 3000, default: 1000 },
  refineLevel: { min: 1, max: 5, default: 3 },
  inletVelocity: { min: 1, max: 100, default: 20 },
});

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

/** The run parameters, clamped. Client values are never trusted as given. */
export function clampRunParams(raw = {}) {
  const debug = raw.debug_mesh === true;
  const level = clampInt(raw.refine_level, LIMITS.refineLevel.min, LIMITS.refineLevel.max,
                         LIMITS.refineLevel.default);
  const fineness = debug ? 1.0 : (FINENESS[level] ?? 9.5);
  return {
    iteration_count: clampInt(raw.iteration_count, LIMITS.iterations.min, LIMITS.iterations.max,
                              LIMITS.iterations.default),
    refine_level: level,
    inlet_velocity: clampNum(raw.inlet_velocity, LIMITS.inletVelocity.min, LIMITS.inletVelocity.max,
                             LIMITS.inletVelocity.default),
    debug_mesh: debug,
    fineness,
    mesh_cells_m: debug ? 0.1 : ((fineness - 7.0) * 15.0 / 3.0 + 5.0),
  };
}

/** List price, before any per-account discount. Level 1 is 100 cr/1000 iterations, level 5 is 200. */
export function listPrice(p) {
  const per1000 = p.debug_mesh ? 1 : 100 + (p.refine_level - 1) * 25;
  return Math.max(1, Math.round(per1000 * p.iteration_count / 1000));
}

/**
 * A sponsored team's multiplier on the list price.
 *
 * Sponsorship discounts a run, it does not make one free. Only an unlimited
 * pass does, which is why chargeFor keeps a floor of one credit.
 */
export function sponsorRate(user) {
  if (!user || user.sponsored !== true) return 1;
  const r = Number(user.sponsor_rate);
  return r > 0 && r <= 1 ? r : 1;
}

/** True while the account holds an unlimited pass that has not expired. */
export function hasUnlimited(user, now = Date.now()) {
  const until = user && user.unlimited_until;
  if (!until) return false;
  const ms = typeof until.toMillis === "function" ? until.toMillis() : Number(until);
  return Number.isFinite(ms) && ms > now;
}

/** What this account is actually charged. The only function a quote should call. */
export function chargeFor(user, p, now = Date.now()) {
  if (hasUnlimited(user, now)) return 0;
  return Math.max(1, Math.round(listPrice(p) * sponsorRate(user)));
}
