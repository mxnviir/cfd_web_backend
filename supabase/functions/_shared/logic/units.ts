// The exact unit strings SimScale expects. Build spec 14.5.
//
// These are compared as strings by the API, and two of them contain
// characters that do not survive a careless round trip: the superscript two
// in m²/s² and the superscript three in kg/m³. A file saved as latin-1, a
// terminal that cannot print them, or a copy through a spreadsheet turns
// "m²/s²" into "mÂ²/sÂ²", which SimScale rejects with a message about the
// value rather than the unit, and the search for that goes in the wrong
// direction for an hour.
//
// So they live here once, as escapes, and nothing else writes a unit literal.
// src/lib/units.js is the browser's copy of the same idea for display; this
// one is what goes on the wire.
export const UNITS = {
  /** Length. */
  m: "m",
  /** Area. */
  m2: "m²",
  /** Volume. */
  m3: "m³",
  /** Speed. */
  mps: "m/s",
  /** Pressure, gauge or absolute. */
  Pa: "Pa",
  /** Time. */
  s: "s",
  /** Density. */
  kgpm3: "kg/m³",
  /** Kinematic viscosity, and nuTilda. */
  m2ps: "m²/s",
  /** Turbulent kinetic energy. */
  m2ps2: "m²/s²",
  /** Dissipation rate. */
  m2ps3: "m²/s³",
  /** Specific dissipation rate. */
  perS: "1/s",
  /** Angular velocity. */
  radps: "rad/s",
  /** Volumetric flow rate. */
  m3ps: "m³/s",
  /** Mass flow rate. */
  kgps: "kg/s",
} as const;

export type Unit = typeof UNITS[keyof typeof UNITS];

/** Every unit string above, for a zod enum. */
export const UNIT_VALUES = Object.values(UNITS) as [Unit, ...Unit[]];
