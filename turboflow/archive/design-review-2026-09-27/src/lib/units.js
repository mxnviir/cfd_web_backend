// Units for the Workbench fields.
//
// Build spec section 3.5: storage is SI, always. A project's unit system and
// each field's dropdown change only what is shown. The stored value is the SI
// base unit, so nothing downstream, including everything sent to SimScale, has
// to know or ask which units the user was typing in.
//
// Every factor here is exact by definition, not rounded: an inch is 0.0254 m
// by international agreement, a mile is 1609.344 m, a pound-force per square
// inch is 6894.757293168361 Pa. Writing 6894.76 would put a rounding error
// into a pressure the solver then treats as given.

/**
 * Each family maps a unit symbol to how many SI base units it is worth.
 * `base` is what the value is stored in.
 */
export const UNITS = Object.freeze({
  length: {
    base: "m",
    factors: Object.freeze({ m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 }),
  },
  speed: {
    base: "m/s",
    factors: Object.freeze({ "m/s": 1, "km/h": 1000 / 3600, mph: 1609.344 / 3600 }),
  },
  pressure: {
    base: "Pa",
    factors: Object.freeze({ Pa: 1, kPa: 1000, bar: 100000, psi: 6894.757293168361 }),
  },
  angle: {
    base: "rad",
    factors: Object.freeze({ rad: 1, deg: Math.PI / 180 }),
  },
  area: {
    base: "m²",
    factors: Object.freeze({ "m²": 1, "cm²": 1e-4, "mm²": 1e-6, "in²": 0.0254 ** 2 }),
  },
  time: {
    base: "s",
    factors: Object.freeze({ s: 1, min: 60, h: 3600 }),
  },
  // Only for the gravity vector, which a steady-state incompressible run
  // ignores anyway. One unit, so the field shows a suffix rather than a
  // dropdown with nothing to choose.
  acceleration: {
    base: "m/s²",
    factors: Object.freeze({ "m/s²": 1 }),
  },
});

/** The unit symbols a dropdown should offer for a family, in display order. */
export function unitsFor(family) {
  const f = UNITS[family];
  if (!f) throw new Error(`No such unit family: ${family}`);
  return Object.keys(f.factors);
}

/** The SI base symbol for a family. */
export function baseUnit(family) {
  const f = UNITS[family];
  if (!f) throw new Error(`No such unit family: ${family}`);
  return f.base;
}

function factor(family, unit) {
  const f = UNITS[family];
  if (!f) throw new Error(`No such unit family: ${family}`);
  const k = f.factors[unit];
  if (k === undefined) throw new Error(`${unit} is not a ${family} unit`);
  return k;
}

/** A number the user typed, in `unit`, as the SI value to store. */
export function toBase(value, family, unit) {
  const n = Number(value);
  return Number.isFinite(n) ? n * factor(family, unit) : NaN;
}

/** A stored SI value, as a number to show in `unit`. */
export function fromBase(value, family, unit) {
  const n = Number(value);
  return Number.isFinite(n) ? n / factor(family, unit) : NaN;
}

/**
 * Round for display without lying about precision.
 *
 * A field showing a converted value must not print 0.30480000000000002, and
 * must not print 0 for a small one. Significant figures do both: four of them
 * keep 0.0254 as 0.0254 and 1609.344 as 1609.
 */
export function forDisplay(value, sig = 4) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return Number.isFinite(n) ? 0 : NaN;
  const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(Math.abs(n))));
  return Number(n.toFixed(Math.min(20, digits)));
}

/** SI or Imperial defaults, which is all a project's unit system decides. */
export const UNIT_SYSTEMS = Object.freeze({
  SI: Object.freeze({ length: "m", speed: "m/s", pressure: "Pa", angle: "deg", area: "m²", time: "s" }),
  IMPERIAL: Object.freeze({ length: "ft", speed: "mph", pressure: "psi", angle: "deg", area: "in²", time: "s" }),
});

/** The unit a field should open with, given the project's system. */
export function defaultUnit(system, family) {
  const s = UNIT_SYSTEMS[system] || UNIT_SYSTEMS.SI;
  return s[family] || baseUnit(family);
}
