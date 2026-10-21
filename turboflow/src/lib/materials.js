// The fluid library the Material dialog offers. Build spec 9.6.
//
// Same fourteen fluids as SimScale, in the same order, so a team following a
// SimScale tutorial finds the row where they expect it.
//
// Air and Water are verified against SimScale's own dialog. The other twelve
// are standard values at 20 C and one atmosphere, and are marked so: the
// dialog says as much next to them, because a density that is nearly right
// is worse than one that is obviously missing. A car is run in air, so the
// one that matters is verified.
//
// Kinematic viscosity is m²/s and density is kg/m³, which is what SimScale
// wants. Dynamic viscosity is not stored: nu = mu / rho and keeping both
// invites the two to disagree.
export const FLUIDS = [
  { id: "air", name: "Air", nu: 1.529e-5, rho: 1.196, verified: true },
  { id: "argon", name: "Argon", nu: 1.34e-5, rho: 1.661, verified: false },
  { id: "co2", name: "Carbon dioxide", nu: 8.32e-6, rho: 1.842, verified: false },
  { id: "crude", name: "Crude oil", nu: 3.0e-5, rho: 870, verified: false },
  { id: "r134a-gas", name: "Gaseous R-134a", nu: 2.6e-6, rho: 4.25, verified: false },
  { id: "gasoline", name: "Gasoline", nu: 6.0e-7, rho: 740, verified: false },
  { id: "hydrogen", name: "Hydrogen", nu: 1.06e-4, rho: 0.0838, verified: false },
  { id: "r134a-liq", name: "Liquid R-134a", nu: 1.7e-7, rho: 1207, verified: false },
  { id: "sae30-120", name: "Lubricating oil SAE 30 120C", nu: 1.0e-5, rho: 838, verified: false },
  { id: "sae30-20", name: "Lubricating oil SAE 30 20C", nu: 3.5e-4, rho: 891, verified: false },
  { id: "nitrogen", name: "Nitrogen", nu: 1.56e-5, rho: 1.16, verified: false },
  { id: "seawater", name: "Seawater 3.5 pc saline", nu: 1.05e-6, rho: 1025, verified: false },
  { id: "so2", name: "Sulphur dioxide", nu: 4.3e-6, rho: 2.72, verified: false },
  { id: "water", name: "Water", nu: 1.0e-6, rho: 997, verified: true },
];

export const VISCOSITY_MODELS = [
  ["NEWTONIAN", "Newtonian"],
  ["POWER_LAW", "Power law"],
  ["CROSS_POWER_LAW", "Cross power law"],
  ["BIRD_CARREAU", "Bird-Carreau"],
  ["HERSCHEL_BULKLEY", "Herschel-Bulkley"],
];

/** One fluid as the JSON SimScale wants inside materials.fluids. */
export function fluidSpec(fluid, name = fluid.name) {
  return {
    name,
    type: "INCOMPRESSIBLE",
    viscosityModel: {
      type: "NEWTONIAN",
      kinematicViscosity: { value: fluid.nu, unit: "m²/s" },
    },
    density: { value: fluid.rho, unit: "kg/m³" },
    topologicalReference: { entities: [], faces: [] },
  };
}
