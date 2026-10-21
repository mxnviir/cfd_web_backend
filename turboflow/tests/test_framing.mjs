// Fit to view must put the model where the user can see it.
//
// The Workbench floats the settings panel over the left 362px of a 623px
// viewer. Fit to view knew nothing about it and centred the car in the whole
// canvas, which put it squarely behind the panel.
//
// Checked here rather than by reading the viewer's pixels: a browser pane that
// is behind another window paints about two frames a second and reports an
// empty canvas whether the maths is right or wrong. That cost an hour once.
import * as THREE from "three";
import { framing } from "../src/workbench/viewer/engine.js";

const fails = [];
const check = (what, ok, detail) => { if (!ok) fails.push(`${what}${detail ? ": " + detail : ""}`); };

/** Where the bounding sphere lands on screen, in CSS pixels from the top left. */
function project({ radius = 1, cw, ch, inset, fov = 35 }) {
  const vFov = (fov * Math.PI) / 180;
  const aspect = cw / ch;
  const { dist, dx, dy } = framing(radius, cw, ch, inset, vFov, aspect);

  const centre = new THREE.Vector3(0, 0, 0);
  const dir = new THREE.Vector3(0.8, -0.8, 0.6).normalize();
  const cam = new THREE.PerspectiveCamera(fov, aspect, radius / 1000, radius * 100);
  cam.up.set(0, 0, 1);
  cam.position.copy(centre).addScaledVector(dir, dist);
  cam.lookAt(centre);
  cam.updateMatrixWorld();

  const target = centre.clone();
  const shift = new THREE.Vector3()
    .setFromMatrixColumn(cam.matrixWorld, 0).multiplyScalar(dx)
    .addScaledVector(new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1), dy);
  cam.position.add(shift);
  target.add(shift);
  cam.lookAt(target);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();

  // Sample the sphere rather than its centre alone, so "fits" means all of it.
  const pts = [centre];
  for (const s of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
    pts.push(new THREE.Vector3(...s).multiplyScalar(radius));
  }
  const screen = pts.map((p) => {
    const v = p.clone().project(cam);
    return { x: ((v.x + 1) / 2) * cw, y: ((1 - v.y) / 2) * ch };
  });
  return {
    centre: screen[0],
    minX: Math.min(...screen.map((s) => s.x)), maxX: Math.max(...screen.map((s) => s.x)),
    minY: Math.min(...screen.map((s) => s.y)), maxY: Math.max(...screen.map((s) => s.y)),
  };
}

// ── the real case: 623 x 634 viewer, 361px of settings panel down the left ──
{
  const cw = 623, ch = 634, left = 361;
  const r = project({ cw, ch, inset: { left } });
  const freeCentre = left + (cw - left) / 2;
  check("centred in the free strip, not the canvas",
        Math.abs(r.centre.x - freeCentre) < 6,
        `centre ${r.centre.x.toFixed(0)}px, free strip centre ${freeCentre.toFixed(0)}px`);
  check("clear of the panel", r.minX > left - 1,
        `left edge ${r.minX.toFixed(0)}px, panel ends ${left}px`);
  check("inside the canvas", r.maxX < cw + 1 && r.minY > -1 && r.maxY < ch + 1,
        `x ${r.minX.toFixed(0)}..${r.maxX.toFixed(0)}, y ${r.minY.toFixed(0)}..${r.maxY.toFixed(0)}`);
  check("vertically centred", Math.abs(r.centre.y - ch / 2) < 6, `${r.centre.y.toFixed(0)}px`);
}

// ── nothing floating: the old behaviour, unchanged ─────────────────────────
{
  const cw = 900, ch = 600;
  const r = project({ cw, ch, inset: {} });
  check("no inset means dead centre",
        Math.abs(r.centre.x - cw / 2) < 1 && Math.abs(r.centre.y - ch / 2) < 1,
        `${r.centre.x.toFixed(1)}, ${r.centre.y.toFixed(1)}`);
  check("still fits with no inset", r.minX > -1 && r.maxX < cw + 1);
}

// ── the job drawer along the bottom ────────────────────────────────────────
{
  const cw = 900, ch = 600, bottom = 140;
  const r = project({ cw, ch, inset: { bottom } });
  check("pushed up above the drawer", r.centre.y < ch / 2 - 20, `${r.centre.y.toFixed(0)}px`);
  check("clear of the drawer", r.maxY < ch - bottom + 1,
        `bottom edge ${r.maxY.toFixed(0)}px, drawer starts ${ch - bottom}px`);
}

// ── a panel wider than the viewer must not send the model to infinity ──────
{
  const cw = 400, ch = 600;
  const r = project({ cw, ch, inset: { left: 380, bottom: 590 } });
  check("absurd inset is clamped, model still on screen",
        Number.isFinite(r.centre.x) && r.centre.x > 0 && r.centre.x < cw,
        `${r.centre.x.toFixed(0)}px`);
}

// ── a tall thin viewer, where the horizontal field is the binding one ──────
{
  const cw = 300, ch = 900;
  const r = project({ cw, ch, inset: {} });
  check("fits a tall thin viewer sideways", r.minX > -1 && r.maxX < cw + 1,
        `x ${r.minX.toFixed(0)}..${r.maxX.toFixed(0)}`);
}

if (fails.length) {
  console.log("framing: FAILED");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
console.log("framing: 11 checks, the model lands where it can be seen");
