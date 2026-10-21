// Boundary condition panels. Build spec 9.8.
//
// One component with a type dropdown at the top, because that is what
// SimScale shows: the type can be changed in place and the rows below it
// change with it. Splitting this into eleven components would mean eleven
// copies of the assignment block and the type dropdown.
//
// The JSON shapes here are the ones the API wants, including the two that
// differ for no obvious reason: an inlet velocity is wrapped as
// {type:"CONSTANT", value} per component, and a moving wall's is a plain
// vector. Copying one to the other is rejected by SimScale with a message
// about the field name, so both are written out.
import React from "react";
import { Row, Num, Select, Toggle, Vec, Note } from "./fields";
import { Icon } from "../icons";

export const BC_TYPES = [
  ["VELOCITY_INLET_V3", "Velocity inlet"],
  ["VELOCITY_OUTLET_V7", "Velocity outlet"],
  ["PRESSURE_INLET_V31", "Pressure inlet"],
  ["PRESSURE_OUTLET_V30", "Pressure outlet"],
  ["WALL_V34", "Wall"],
  ["SYMMETRY", "Symmetry"],
  ["CUSTOM_V37", "Custom"],
  ["FAN", "Fan"],
  ["PERIODIC", "Periodic"],
  ["EMPTY_2D", "Empty 2D"],
  ["WEDGE", "Wedge"],
];

const constant = (v) => ({ type: "CONSTANT", value: v });
/**
 * A vector of per-component functions, the shape a velocity inlet takes.
 *
 * The `type: "COMPONENT"` is not decoration. It is the discriminator SimScale
 * reads to know this vector is three functions rather than three numbers, and
 * without it the whole simulation is refused with "Missing 'type' property for
 * object 'value'". Every velocity inlet the Workbench wrote was missing it
 * until 11 Sep 2026, which means no inlet had ever reached the solver.
 */
const constantVec = (v) => ({
  type: "COMPONENT",
  x: constant(v.x), y: constant(v.y), z: constant(v.z),
});
const plainVec = (cv) => ({
  x: cv?.x?.value ?? 0, y: cv?.y?.value ?? 0, z: cv?.z?.value ?? 0,
});

/** A fresh boundary condition of a type, with the spec's defaults. */
export function newBoundaryCondition(type, name) {
  const base = { name, type, topologicalReference: { faces: [] } };
  switch (type) {
    case "VELOCITY_INLET_V3":
      return {
        ...base,
        velocity: {
          type: "FIXED_VALUE",
          value: { value: constantVec({ x: 0, y: 0, z: 0 }), unit: "m/s" },
        },
        turbulence: { type: "AUTOMATIC_TURBULENCE" },
      };
    case "VELOCITY_OUTLET_V7":
      return {
        ...base,
        velocity: {
          type: "FIXED_VALUE",
          value: { value: constantVec({ x: 0, y: 0, z: 0 }), unit: "m/s" },
        },
      };
    case "PRESSURE_INLET_V31":
      return {
        ...base,
        gaugePressure: { type: "TOTAL_PRESSURE", value: { value: constant(0), unit: "Pa" } },
        turbulence: { type: "AUTOMATIC_TURBULENCE" },
      };
    case "PRESSURE_OUTLET_V30":
      return {
        ...base,
        gaugePressure: { type: "FIXED_VALUE", value: { value: constant(0), unit: "Pa" } },
      };
    case "WALL_V34":
      return {
        ...base,
        velocity: { type: "NO_SLIP", turbulenceWall: "WALL_FUNCTION" },
      };
    default:
      return base;
  }
}

const VELOCITY_INLET_TYPES = [
  ["FIXED_VALUE", "Fixed value"],
  ["FIXED_VALUE_NO_EXPRESSION", "Fixed magnitude (no expression)"],
  ["FIXED_MEAN", "Mean value"],
  ["FLOW_RATE_INLET_VELOCITY", "Volumetric or mass flow rate"],
  ["FLOW_RATE_MEAN_INLET_VELOCITY", "Mean flow rate"],
  ["FREESTREAM", "Freestream"],
];

const TURBULENCE_TYPES = [
  ["AUTOMATIC_TURBULENCE", "Automatic"],
  ["TURBULENT_INTENSITY_AND_REFERENCE_LENGTH_TURBULENCE", "Intensity and length scale"],
  ["FIXED_VALUE_TURBULENCE", "Fixed values"],
];

function TurbulenceRows({ bc, onChange }) {
  const t = bc.turbulence ?? { type: "AUTOMATIC_TURBULENCE" };
  const set = (next) => onChange({ ...bc, turbulence: { ...t, ...next } });
  return (
    <>
      <Row label="Turbulence">
        <Select value={t.type} options={TURBULENCE_TYPES}
          onChange={(v) => onChange({ ...bc, turbulence: { type: v } })} />
      </Row>
      {t.type === "TURBULENT_INTENSITY_AND_REFERENCE_LENGTH_TURBULENCE" ? (
        <>
          <Row label="Turbulence intensity" hint="A fraction, so 0.05 is five per cent.">
            <Num value={t.turbulenceIntensity ?? 0.05} width={90}
              onChange={(v) => set({ turbulenceIntensity: v })} />
          </Row>
          <Row label="Reference length">
            <Num value={t.referenceLength?.value ?? 0.1} quantity="length" unit="m"
              onChange={(v) => set({ referenceLength: { value: v, unit: "m" } })} />
          </Row>
        </>
      ) : null}
      {t.type === "FIXED_VALUE_TURBULENCE" ? (
        <>
          <Row label="k">
            <Num value={t.turbulentKineticEnergy?.value ?? 0.00375} width={100}
              onChange={(v) => set({ turbulentKineticEnergy: { value: v, unit: "m²/s²" } })} />
            <span className="wb-unit wb-unit-fixed">m²/s²</span>
          </Row>
          {/* ω, not w: w is the z component of velocity, and this row sits
              a few lines from one. */}
          <Row label="ω">
            <Num value={t.omegaDissipationRate?.value ?? 3.375} width={100}
              onChange={(v) => set({ omegaDissipationRate: { value: v, unit: "1/s" } })} />
            <span className="wb-unit wb-unit-fixed">1/s</span>
          </Row>
        </>
      ) : null}
    </>
  );
}

const WALL_VELOCITY = [
  ["NO_SLIP", "No-slip"], ["SLIP", "Slip"],
  ["MOVING_WALL_VELOCITY", "Moving wall"], ["ROTATING_WALL_VELOCITY", "Rotating wall"],
];

function WallRows({ bc, onChange, wheel }) {
  const v = bc.velocity ?? { type: "NO_SLIP" };
  const set = (next) => onChange({ ...bc, velocity: { ...v, ...next } });

  const wallTreatment = (
    <Row label="Wall treatment">
      <Select value={v.turbulenceWall ?? "WALL_FUNCTION"}
        options={[["WALL_FUNCTION", "Wall function"], ["FULL_RESOLUTION", "Full resolution"]]}
        onChange={(x) => set({ turbulenceWall: x })} />
    </Row>
  );

  return (
    <>
      <Row label="(U) Velocity">
        <Select value={v.type} options={WALL_VELOCITY}
          onChange={(x) => {
            // Keep the type's own required fields present; SimScale rejects a
            // rotating wall with no rotation block rather than defaulting it.
            if (x === "ROTATING_WALL_VELOCITY") {
              onChange({
                ...bc,
                velocity: {
                  type: x, turbulenceWall: v.turbulenceWall ?? "WALL_FUNCTION",
                  rotation: v.rotation ?? {
                    rotationCenter: { value: { x: 0, y: 0, z: 0 }, unit: "m" },
                    rotationAxis: { x: 0, y: 1, z: 0 },
                    angularVelocity: { value: constant(0), unit: "rad/s" },
                  },
                },
              });
            } else if (x === "MOVING_WALL_VELOCITY") {
              onChange({
                ...bc,
                velocity: {
                  type: x, turbulenceWall: v.turbulenceWall ?? "WALL_FUNCTION",
                  value: v.value ?? { value: { x: 0, y: 0, z: 0 }, unit: "m/s" },
                },
              });
            } else {
              onChange({ ...bc, velocity: { type: x, ...(x === "SLIP" ? {} : { turbulenceWall: v.turbulenceWall ?? "WALL_FUNCTION" }) } });
            }
          }} />
      </Row>

      {v.type === "NO_SLIP" ? (
        <>
          {wallTreatment}
          <Row label="Surface roughness">
            <Toggle value={!!v.enableSurfaceRoughness} label="Surface roughness"
              onChange={(x) => set({ enableSurfaceRoughness: x })} />
          </Row>
          {v.enableSurfaceRoughness ? (
            <Row label="Roughness height" indent>
              <Num value={v.surfaceRoughness?.value ?? 0} quantity="length" unit="m"
                onChange={(x) => set({ surfaceRoughness: { value: x, unit: "m" } })} />
            </Row>
          ) : null}
        </>
      ) : null}

      {v.type === "MOVING_WALL_VELOCITY" ? (
        <>
          {wallTreatment}
          <Row label="Wall velocity">
            {/* A plain vector here, not the CONSTANT wrapper an inlet uses. */}
            <Vec value={v.value?.value ?? { x: 0, y: 0, z: 0 }} quantity="speed" unit="m/s"
              onChange={(x) => set({ value: { value: x, unit: "m/s" } })} />
          </Row>
        </>
      ) : null}

      {v.type === "ROTATING_WALL_VELOCITY" ? (
        <>
          {wallTreatment}
          <Row label="Point on axis" group>
            <Vec value={v.rotation?.rotationCenter?.value ?? { x: 0, y: 0, z: 0 }}
              quantity="length" unit="m"
              onChange={(x) => set({
                rotation: { ...v.rotation, rotationCenter: { value: x, unit: "m" } },
              })} />
          </Row>
          <Row label="Rotation axis" group>
            <Vec value={v.rotation?.rotationAxis ?? { x: 0, y: 1, z: 0 }}
              onChange={(x) => set({ rotation: { ...v.rotation, rotationAxis: x } })} />
          </Row>
          <Row label="Rotational velocity">
            <Num value={v.rotation?.angularVelocity?.value?.value ?? 0} width={100}
              onChange={(x) => set({
                rotation: {
                  ...v.rotation,
                  angularVelocity: { value: constant(x), unit: "rad/s" },
                },
              })} />
            <span className="wb-unit wb-unit-fixed">rad/s</span>
          </Row>
          {/*
            The one thing here SimScale does not have. omega = U / r is the
            number a rotating wheel needs and it is worked out today inside
            the worker, from entity_labels.csv, where nobody can see it or
            change it. The faces are already selected and faces.json already
            has the radius and the axis, so the button just does the sum.
          */}
          {wheel ? (
            <div className="wb-fillrow">
              <button type="button" className="wb-btn" onClick={wheel.onFill}
                disabled={!wheel.ready}>
                <Icon name="refresh" size={14} /> Fill from wheel
              </button>
              <span className="wb-dim">
                {wheel.ready
                  ? `radius ${(wheel.radius * 1000).toFixed(1)} mm, ${wheel.speed} m/s, so ${(wheel.speed / wheel.radius).toFixed(1)} rad/s`
                  : "Assign the cylindrical faces of one wheel first."}
              </span>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

export default function BoundaryConditionPanel({ bc, onChange, assignment, wheel }) {
  const set = (next) => onChange({ ...bc, ...next });

  return (
    <>
      <Row label="Boundary conditions">
        <Select value={bc.type} options={BC_TYPES}
          onChange={(t) => onChange({
            ...newBoundaryCondition(t, bc.name),
            topologicalReference: bc.topologicalReference,
          })} />
      </Row>

      {bc.type === "VELOCITY_INLET_V3" ? (
        <>
          <Row label="(U) Velocity">
            <Select value={bc.velocity?.type ?? "FIXED_VALUE"} options={VELOCITY_INLET_TYPES}
              onChange={(t) => set({ velocity: { ...bc.velocity, type: t } })} />
          </Row>
          {["FIXED_VALUE", "FIXED_VALUE_NO_EXPRESSION", "FIXED_MEAN", "FREESTREAM"]
            .includes(bc.velocity?.type ?? "FIXED_VALUE") ? (
              <Row label="Velocity"
                /* Not "use a negative x velocity", which is what this said
                   until 11 Sep 2026. That was the old Fusion pipeline's
                   convention baked into a label: it built tunnels with the
                   inlet at max x. A tunnel built by /prepare has its inlet at
                   min x and wants +x, and a car imported from anywhere else
                   can face any way at all. State the rule instead of one
                   case of it. */
                hint="Point this along the wind, from the inlet face towards the car. Check the axes on the orientation ball if you are not sure which way that is." group>
                <Vec value={plainVec(bc.velocity?.value?.value)} quantity="speed" unit="m/s"
                  onChange={(x) => set({
                    velocity: { ...bc.velocity, value: { value: constantVec(x), unit: "m/s" } },
                  })} />
              </Row>
            ) : (
              <Row label="Flow rate">
                <Num value={bc.velocity?.flowRate?.value ?? 0} width={100}
                  onChange={(x) => set({
                    velocity: {
                      ...bc.velocity,
                      flowRate: { type: bc.velocity?.flowRate?.type ?? "VOLUMETRIC", value: x },
                    },
                  })} />
                <Select value={bc.velocity?.flowRate?.type ?? "VOLUMETRIC"}
                  options={[["VOLUMETRIC", "m³/s"], ["MASS", "kg/s"]]}
                  onChange={(x) => set({
                    velocity: {
                      ...bc.velocity,
                      flowRate: { type: x, value: bc.velocity?.flowRate?.value ?? 0 },
                    },
                  })} />
              </Row>
            )}
          <TurbulenceRows bc={bc} onChange={onChange} />
        </>
      ) : null}

      {bc.type === "VELOCITY_OUTLET_V7" ? (
        <>
          <Row label="(U) Velocity">
            <Select value={bc.velocity?.type ?? "FIXED_VALUE"}
              options={[
                ["FIXED_VALUE", "Fixed value"], ["FIXED_MEAN", "Mean value"],
                ["FLOW_RATE_OUTLET_VELOCITY", "Volumetric or mass flow rate"],
                ["FLOW_RATE_MEAN_OUTLET_VELOCITY", "Mean flow rate"],
                ["STABLE_FLOW_RATE", "Stable flow rate"],
              ]}
              onChange={(t) => set({ velocity: { ...bc.velocity, type: t } })} />
          </Row>
          <Row label="Velocity" group>
            <Vec value={plainVec(bc.velocity?.value?.value)} quantity="speed" unit="m/s"
              onChange={(x) => set({
                velocity: { ...bc.velocity, value: { value: constantVec(x), unit: "m/s" } },
              })} />
          </Row>
        </>
      ) : null}

      {bc.type === "PRESSURE_INLET_V31" || bc.type === "PRESSURE_OUTLET_V30" ? (
        <>
          <Row label={bc.type === "PRESSURE_INLET_V31" ? "Pressure type" : "(P) Pressure"}>
            <Select value={bc.gaugePressure?.type ?? "FIXED_VALUE"}
              options={bc.type === "PRESSURE_INLET_V31"
                ? [["TOTAL_PRESSURE", "Total pressure"], ["FIXED_VALUE", "Fixed value"], ["FIXED_MEAN", "Mean value"]]
                : [["FIXED_VALUE", "Fixed value"], ["FIXED_MEAN", "Mean value"]]}
              onChange={(t) => set({ gaugePressure: { ...bc.gaugePressure, type: t } })} />
          </Row>
          <Row label="(P) Gauge pressure">
            <Num value={bc.gaugePressure?.value?.value?.value ?? 0} quantity="pressure" unit="Pa"
              onChange={(x) => set({
                gaugePressure: { ...bc.gaugePressure, value: { value: constant(x), unit: "Pa" } },
              })} />
          </Row>
          {bc.type === "PRESSURE_INLET_V31" ? <TurbulenceRows bc={bc} onChange={onChange} /> : null}
        </>
      ) : null}

      {bc.type === "WALL_V34" ? <WallRows bc={bc} onChange={onChange} wheel={wheel} /> : null}

      {["SYMMETRY", "CUSTOM_V37", "FAN", "PERIODIC", "EMPTY_2D", "WEDGE"].includes(bc.type) ? (
        <Note>
          {bc.type === "SYMMETRY"
            ? "A symmetry plane needs no settings beyond which faces it is."
            : "This type is in the list for completeness. A STEM Racing car does not need it, and its fields are not filled in here yet."}
        </Note>
      ) : null}

      {assignment}
    </>
  );
}
