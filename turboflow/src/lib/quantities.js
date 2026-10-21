// The quantities TurboFlow reports, and how each one is written down.
//
// What this replaces: `Number(value).toPrecision(4)` for every figure on the
// run panel, whatever it was. Significant figures are the wrong tool here,
// because they are a property of the number rather than of the thing measured:
//
//     drag  0.127  ->  "0.1270"     a trailing zero the solve does not support
//     Cd    0.352  ->  "0.3520"     same
//     drag  1.4    ->  "1.400"
//     lift -2.5    ->  "-2.500"
//
// Every one of those claims a digit of precision that is not there, and the
// column does not line up, because four significant figures is a different
// number of decimal places depending on the value. A team reading two runs side
// by side is comparing 0.1270 against 0.1350 and counting characters.
//
// Decimal places, fixed per quantity, chosen from what the quantity is:
//
//   force        3 dp.  A STEM Racing car sits between about 0.1 and 2 N, so
//                       three places is a milli-newton, which is finer than the
//                       solver is converged to and is what these teams quote.
//   coefficient  3 dp.  Cd is around 0.35 and the third place is the one that
//                       changes between design iterations.
//   moment       4 dp.  Pitching moments on a 250 mm car are hundredths of a
//                       newton-metre, so three places would round most of the
//                       signal away.
//
// Anything far outside its expected range falls back to exponential rather than
// printing fifteen zeros.

/** What each key on a run summary is, in the terms an engineer would use. */
export const QUANTITIES = {
  drag: { label: "Drag", unit: "N", dp: 3, better: "lower" },
  lift: { label: "Lift", unit: "N", dp: 3, better: null },
  side: { label: "Side force", unit: "N", dp: 3, better: null },
  cd: { label: "Cd", unit: "", dp: 3, better: "lower" },
  cl: { label: "Cl", unit: "", dp: 3, better: null },
  cm: { label: "Cm", unit: "", dp: 3, better: null },
  pitch: { label: "Pitch", unit: "N m", dp: 4, better: null },
  roll: { label: "Roll", unit: "N m", dp: 4, better: null },
  yaw: { label: "Yaw", unit: "N m", dp: 4, better: null },
};

/** The two figures a run is actually read for. Everything else supports them. */
export const HEADLINE = ["drag", "cd"];
/** Worth showing, once the headline has been read. */
export const SECONDARY = ["lift", "cl", "pitch"];
/**
 * Zero by construction on a half model, because a car's two halves cancel.
 * Shown only when they are not zero, so a full-tunnel run still reports them
 * and a half-tunnel run does not print three zeroes and leave the reader
 * wondering whether the solve went wrong.
 */
export const MIRRORED = ["side", "roll", "yaw"];

/**
 * One figure, written the way its quantity is written.
 *
 * Returns a string, never null: a caller that has a number to show should not
 * have to decide what "no number" looks like.
 */
const numeric = (v) =>
  (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number.isFinite(Number(v));

export function formatQuantity(value, key) {
  const q = QUANTITIES[key];
  const dp = q?.dp ?? 3;
  if (!numeric(value)) return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (n === 0) return (0).toFixed(dp);
  // Only the top end goes exponential.
  //
  // It used to drop out of the fixed format at the bottom too, so a lift of
  // 0.000365 N printed as "3.65e-4" in a column beside "0.127" and "-0.0078".
  // That is a true number and a worse answer: it breaks the decimal alignment
  // that tabular figures exist to create, and it claims three significant
  // figures of a quantity that, on a 250 mm car, is zero. "0.000" says
  // "below a milli-newton", which is what the solve actually supports.
  //
  // The upper fallback stays: six figures before the point is a wall, and a
  // number that large is a unit mistake worth seeing as one.
  if (Math.abs(n) >= 1e6) return n.toExponential(2);
  return n.toFixed(dp);
}

/** The unit, or an empty string for a dimensionless coefficient. */
export function unitOf(key) {
  return QUANTITIES[key]?.unit ?? "";
}

export function labelOf(key) {
  return QUANTITIES[key]?.label ?? key;
}

/**
 * This run against the one before it.
 *
 * Returns null when there is nothing to compare, so a first run shows a figure
 * and no delta rather than "0.000 (0%)", which reads as "no change" when the
 * truth is "no previous run".
 *
 * `direction` is "better", "worse" or "neutral". Only drag and Cd have a
 * better: lift has no universally good sign, because downforce is negative
 * lift and a team may be chasing either. Claiming an improvement the user did
 * not ask for is worse than saying nothing.
 */
export function compareQuantity(now, before, key) {
  if (!numeric(now) || !numeric(before)) return null;
  const a = Number(now);
  const b = Number(before);
  const delta = a - b;
  if (delta === 0) return { delta: 0, percent: 0, direction: "neutral", key };

  const percent = b === 0 ? null : (delta / Math.abs(b)) * 100;
  const better = QUANTITIES[key]?.better;
  let direction = "neutral";
  if (better === "lower") direction = delta < 0 ? "better" : "worse";
  else if (better === "higher") direction = delta > 0 ? "better" : "worse";

  return { delta, percent, direction, key };
}

/** "0.008 lower" / "0.021 higher", for a screen reader and for a tooltip. */
export function describeChange(cmp) {
  if (!cmp) return "";
  if (cmp.delta === 0) return "no change from the previous run";
  const way = cmp.delta < 0 ? "lower" : "higher";
  const size = formatQuantity(Math.abs(cmp.delta), cmp.key);
  const pct = cmp.percent == null ? "" : ` (${Math.abs(cmp.percent).toFixed(1)}%)`;
  return `${size}${unitOf(cmp.key) ? " " + unitOf(cmp.key) : ""} ${way}${pct} than the previous run`;
}
