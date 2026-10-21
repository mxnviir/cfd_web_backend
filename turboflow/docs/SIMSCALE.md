# What SimScale offers an incompressible run, and what we take

Checked against the pinned SDK (9.2.0) and SimScale's own docs, not from memory.
The SDK is the authority: every class named here exists in
`simscale_sdk/models/` and the ones marked "taken" are constructed in
`services/simscale-job/simscale_job.py`.

## Solution fields

These are what the solver writes into the result package, which is what the
viewer colours the car with.

| Field | Written by default | We show it |
|---|---|---|
| Pressure `p` | yes | yes |
| Velocity `Ux, Uy, Uz` | yes | yes, collapsed to magnitude |
| Turbulent kinetic energy `k` | yes | yes |
| Turbulent viscosity `nut` | yes | yes |
| Dissipation `epsilon`, `omega` | yes | yes |
| Wall shear stress | on request | no |
| Vorticity | on request | no |
| `y+` | on request | no |
| Total pressure `pt` | on request | no |
| Pressure coefficient `Cp` | on request | no |
| Reynolds stress tensor | on request | no |
| Mean age of fluid | on request | no |

The "on request" ones are `field_calculations` entries on `FluidResultControls`:
`FieldCalculationsPressureResultControl` (with `PressureCoefficientResultType`
or `TotalPressureResultType`), `FieldCalculationsFrictionVelocityResultControl`
(y+ and wall shear), `FieldCalculationsVelocityResultControl`
(`VorticityResultType`), `FieldCalculationsTurbulenceResultControl`.

Two of those are worth more than the rest for a school team:

- **`y+`** says whether the mesh is fine enough for the turbulence model to mean
  anything. Without it a team cannot tell a converged answer from a converged
  wrong answer.
- **`Cp`** is the field people actually reason about when they look at a car.
  Pressure in pascals depends on how fast you ran it; Cp does not, so two runs
  at different speeds can be compared.

## Result controls

`FluidResultControls` takes: `forces_moments`, `surface_data`, `probe_points`,
`field_calculations`, `scalar_transport`, `transient_result_control`,
`statistical_averaging_result_control`, `snapshot_result_control`,
`custom_comfort_criteria`.

| Control | Gives | Status |
|---|---|---|
| `ForcesMomentsResultControl` | forces and moments per iteration, split into pressure and viscous | **taken**, all channels |
| `ForceMomentCoefficientsResultControl` | Cd, Cl and moment coefficients per iteration | **taken** |
| `AreaAverageResultControl` | average of any field over chosen faces | not taken |
| `AreaIntegralResultControl` | integral of any field over chosen faces | not taken |
| `ProbePointsResultControl` | any field at chosen points, like a pressure tap | not taken |
| `FieldCalculations*` | the optional fields above | not taken |
| `StatisticalAveragingResultControlV2` | time-averaged fields | not useful, this is a steady run |

`AreaAverage` on the inlet and outlet would give the pressure drop across the
tunnel and a mass-flow check, which is the cheapest way to catch a run that has
gone wrong without reading residuals.

## What we now take from every run

On the job document, under `plots`:

- `residuals`: one series per solved variable.
- `forces`: `iterations`, `drag`, `lift`, `side`, and `split` holding the
  pressure and viscous contributions separately. Pressure against viscous is
  form drag against skin friction: one is fixed by the shape of the car, the
  other by its surface, and a team cannot act on a total that hides which.
- `moments`: `roll`, `pitch`, `yaw`. Pitch says where the downforce sits, which
  total lift cannot answer.
- `coefficients`: `cd`, `cl`, `cm` per iteration, computed by the solver.

And on the job itself: `drag_n`, `lift_n`, `results_glb_path`, `results_fields`.

## The reference area

Coefficients divide by a reference area, and until now that area was the
bounding box times 0.62, with the factor left to the user. Measured on the three
real cars, the true factor is 0.582, 0.754 and 0.755, so the guess was out by a
fifth in either direction depending on the shape of the car.

`/prepare` now measures it: the shape's shadow along the wind, rasterised so
that bodywork behind bodywork is counted once, clipped to the width of tunnel
actually being built. A whole car in a half tunnel is solved as a half and
reports half the force, so it must be paired with half the area or the
coefficient comes out at twice what it should be.

## Setup options we do not expose

The solver is driven with SDK defaults for most of these, which is deliberate:
a wrong number here is worse than a default, and nothing on screen should
pretend to a precision the run does not have.

| Setting | Now | Worth exposing |
|---|---|---|
| Turbulence model | `KOMEGASST` fixed | maybe, k-epsilon is faster and cruder |
| Relaxation factors | SDK default | no, this is a way to make a run diverge |
| Residual targets | 1e-5 on all four | yes, it is the stopping rule |
| Schemes | SDK default | no |
| End time / iterations | on the simulation row | already exposed |
| Max run time | 36000 s fixed | no |
| Write interval | 1 when debugging, else 100 | tied to the iteration slider |
| Initial conditions | SDK default | no |
