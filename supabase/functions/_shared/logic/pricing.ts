// What a run costs, and what a given account is charged for it.
//
// This has to agree exactly with public/cfd-setup.js, which quotes the price in
// the browser before the user commits. If the two drift, the figure on screen
// is not the figure taken off the account, and the first anyone notices is a
// support message.
/** The account fields pricing reads. */
type UserDoc = { sponsored?: boolean; sponsor_rate?: number; unlimited_until?: any };

/**
 * Simmetrix fineness per refinement level.
 *
 * The old backend interpolated this as 9.0 + (level - 1) * 0.25, which produces
 * 9.25 and 9.75 at levels 2 and 4 — values the worker never meshes with, and
 * which SimScale rejects anyway because fineness must be a multiple of 0.1. The
 * ladder below is the one in simscale_job.py `_FINENESS` and in cfd-setup.js.
 */
export const FINENESS: Readonly<Record<number, number>> = Object.freeze({
  1: 9.0, 2: 9.2, 3: 9.5, 4: 9.7, 5: 10.0,
});

export const LIMITS = Object.freeze({
  iterations: { min: 1, max: 3000, default: 1000 },
  refineLevel: { min: 1, max: 5, default: 3 },
  inletVelocity: { min: 1, max: 100, default: 20 },
});

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

const clampNum = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

/** The run parameters, clamped. Client values are never trusted as given. */
export interface RunParams {
  iteration_count: number;
  refine_level: number;
  inlet_velocity: number;
  debug_mesh: boolean;
  mesh_cells_m: number;
  fineness: number;
}

export function clampRunParams(raw: Record<string, unknown>): RunParams {
  const debug = raw.debug_mesh === true;
  const level = clampInt(raw.refine_level, LIMITS.refineLevel.min, LIMITS.refineLevel.max, LIMITS.refineLevel.default);
  const fineness = debug ? 1.0 : (FINENESS[level] ?? 9.5);
  return {
    iteration_count: clampInt(raw.iteration_count, LIMITS.iterations.min, LIMITS.iterations.max, LIMITS.iterations.default),
    refine_level: level,
    inlet_velocity: clampNum(raw.inlet_velocity, LIMITS.inletVelocity.min, LIMITS.inletVelocity.max, LIMITS.inletVelocity.default),
    debug_mesh: debug,
    fineness,
    mesh_cells_m: debug ? 0.1 : ((fineness - 7.0) * 15.0 / 3.0 + 5.0),
  };
}

/** List price, before any per-account discount. Level 1 is 100 cr/1000 iterations, level 5 is 200. */
export function listPrice(p: Pick<RunParams, "refine_level" | "iteration_count" | "debug_mesh">): number {
  const per1000 = p.debug_mesh ? 1 : 100 + (p.refine_level - 1) * 25;
  return Math.max(1, Math.round(per1000 * p.iteration_count / 1000));
}

/**
 * A sponsored team's multiplier on the list price.
 *
 * Sponsorship discounts simulations, it does not make them free — note the
 * Math.max(1, ...) in chargeFor. Only an unlimited pass is free.
 */
export function sponsorRate(user: UserDoc | undefined): number {
  if (!user || user.sponsored !== true) return 1;
  const r = Number(user.sponsor_rate);
  return r > 0 && r <= 1 ? r : 1;
}

/** True while the account holds an unlimited pass that has not expired. */
export function hasUnlimited(user: UserDoc | undefined, now = Date.now()): boolean {
  const until = user?.unlimited_until;
  if (!until) return false;
  const ms = typeof until.toMillis === "function" ? until.toMillis() : Number(until);
  return Number.isFinite(ms) && ms > now;
}

/** What this account is actually charged. The only function billing should call. */
export function chargeFor(
  user: UserDoc | undefined,
  p: Pick<RunParams, "refine_level" | "iteration_count" | "debug_mesh">,
  now = Date.now(),
): number {
  if (hasUnlimited(user, now)) return 0;
  return Math.max(1, Math.round(listPrice(p) * sponsorRate(user)));
}
