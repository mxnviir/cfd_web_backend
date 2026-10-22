// View orientation cube — the gizmo every CAD tool puts in the corner of the
// viewport, and the fastest way to get back to a known view after orbiting.
//
// Axis convention matches setView() in workbench.html and the labelling rules
// the CAD service uses: Z is up, the freestream runs in −x (the inlet is the
// +x wall, see FINDINGS.md), and the car's nose points −x. So FRONT is the view
// looking into the oncoming flow, which puts the camera on −x. Get this
// backwards and the cube quietly disagrees with the buttons beside it.
//
//   BoxGeometry material order is [+x, −x, +y, −y, +z, −z].
//   +x BACK   −x FRONT   +y LEFT   −y RIGHT   +z TOP   −z BOTTOM
//
// Left is +y because with forward = +x and up = +z, right = forward × up = −y.
import * as THREE from "three";

const FACES = [
  { dir: [ 1, 0, 0], label: "BACK"   },
  { dir: [-1, 0, 0], label: "FRONT"  },
  { dir: [ 0, 1, 0], label: "LEFT"   },
  { dir: [ 0,-1, 0], label: "RIGHT"  },
  { dir: [ 0, 0, 1], label: "TOP"    },
  { dir: [ 0, 0,-1], label: "BOTTOM" },
];

// Palette, lifted from the app's tokens. The cube was built near-white with a
// dark label, which on a #0f1319 viewport reads as a rendering fault rather than
// a control — a bright square is the strongest thing on screen, and it was
// competing with the result it sits next to.
const FACE_FILL   = "#1c242f";   // --panel-2
const FACE_EDGE   = "#3a4757";
const FACE_TEXT   = "#c3cedb";
const EDGE_LINE   = 0x3a4757;
const HILITE      = 0xe0761f;    // --accent (racing amber)

function faceTexture(label, dpr) {
  const S = 128 * dpr;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  g.fillStyle = FACE_FILL; g.fillRect(0, 0, S, S);
  g.strokeStyle = FACE_EDGE; g.lineWidth = Math.max(1, 2 * dpr);
  g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, S - g.lineWidth, S - g.lineWidth);
  g.fillStyle = FACE_TEXT;
  g.font = `600 ${Math.round(S * (label.length > 4 ? 0.15 : 0.19))}px -apple-system,"Segoe UI",Inter,sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.letterSpacing = `${Math.round(S * 0.02)}px`;
  g.fillText(label, S / 2, S / 2);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  // Without this the canvas is treated as linear data and converted linear->sRGB
  // on output, which lifts an authored #1c242f to roughly #606c79 — measured.
  // Dark UI colours are where that error is most visible, because the transfer
  // curve is steepest near black.
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createViewCube({ camera, controls, container, size = 92 }) {
  const dpr = Math.min(devicePixelRatio || 1, 2);

  // Square. A non-square canvas with a square orthographic frustum renders the
  // cube stretched, and — worse — leaves most of the canvas outside the cube so
  // clicks land on nothing. The triad lives inside the same square.
  const host = document.createElement("div");
  host.style.cssText =
    `position:absolute;right:8px;bottom:8px;width:${size}px;height:${size}px;` +
    `z-index:5;cursor:pointer;`;
  container.appendChild(host);

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block;";
  host.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(dpr);
  renderer.setSize(size, size, false);

  const scene = new THREE.Scene();
  // Orthographic: a view cube that changes size as it rotates reads as a bug.
  // ±1.5 against a 1.6 cube — its rotated corners reach 1.39, so it fills the
  // frame without ever clipping.
  const cam = new THREE.OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 40);
  cam.position.set(0, 0, 10);

  const textures = FACES.map((f) => faceTexture(f.label, dpr));
  const materials = textures.map((map) => new THREE.MeshBasicMaterial({ map }));
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), materials);
  scene.add(cube);

  // Hairline wireframe over the cube so edges read even when two faces are
  // nearly co-planar to the viewer.
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(cube.geometry),
    new THREE.LineBasicMaterial({ color: EDGE_LINE }));
  cube.add(edges);

  // Highlight sits slightly proud of the surface so it never z-fights.
  const hi = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: HILITE, transparent: true, opacity: 0.5, depthTest: false }));
  hi.visible = false;
  cube.add(hi);

  // ── axis triad, oriented with the cube ──
  const triad = new THREE.Group();
  // Same ok/warn/bad hues the rest of the app uses, so the triad sits in the
  // palette rather than introducing three new colours.
  const AX = [
    { v: [1, 0, 0], c: 0xe05a52 },   // X — --bad
    { v: [0, 1, 0], c: 0x3fb27a },   // Y — --ok
    { v: [0, 0, 1], c: 0x60a5fa },   // Z — --accent-hi
  ];
  for (const a of AX) {
    const g = new THREE.BufferGeometry().setFromPoints(
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(...a.v).multiplyScalar(0.62)]);
    triad.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: a.c })));
  }
  triad.position.set(-1.05, -1.05, 0);
  scene.add(triad);

  // ── picking: 26 regions from one mesh ──
  // Thresholding the hit point's local coordinates gives face (1 axis engaged),
  // edge (2) and corner (3) without building 26 pick volumes.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const T = 0.60;                       // fraction of the half-extent

  function regionAt(ev) {
    const r = canvas.getBoundingClientRect();
    // The triad occupies the lower strip; ignore picks there.
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, cam);
    const hit = ray.intersectObject(cube, false)[0];
    if (!hit) return null;
    const p = cube.worldToLocal(hit.point.clone()).multiplyScalar(1 / 0.8); // → [-1,1]
    const d = [0, 0, 0];
    ["x", "y", "z"].forEach((ax, i) => { if (Math.abs(p[ax]) > T) d[i] = Math.sign(p[ax]); });
    if (!d[0] && !d[1] && !d[2]) return null;
    return d;
  }

  function showHighlight(d) {
    if (!d) { hi.visible = false; return; }
    // Scale down along engaged axes so a face highlight is a slab, an edge a
    // bar, and a corner a cube — the shape tells you what you are about to hit.
    const s = d.map((v) => (v ? 0.30 : 1.62));
    hi.scale.set(s[0], s[1], s[2]);
    hi.position.set(d[0] * 0.68, d[1] * 0.68, d[2] * 0.68);
    hi.visible = true;
  }

  // ── camera animation ──
  let anim = null;
  const smooth = (t) => t * t * (3 - 2 * t);

  // Returns the destination so the mapping can be asserted without waiting on
  // an animation — requestAnimationFrame is suspended whenever the page is not
  // compositing (background tab, headless check), and a test that depends on it
  // silently passes by never running.
  function goTo(d, { instant = false } = {}) {
    const target = controls.target.clone();
    const dist = camera.position.distanceTo(target) || 1;
    const dir = new THREE.Vector3(d[0], d[1], d[2]).normalize();
    const to = target.clone().add(dir.multiplyScalar(dist));
    if (instant) {
      camera.position.copy(to); camera.up.set(0, 0, 1); controls.update();
      anim = null;
    } else {
      anim = { from: camera.position.clone(), to, t0: performance.now(), ms: 350 };
    }
    return to.toArray();
  }

  function step(now) {
    if (!anim) return;
    const t = Math.min(1, (now - anim.t0) / anim.ms);
    camera.position.lerpVectors(anim.from, anim.to, smooth(t));
    camera.up.set(0, 0, 1);
    controls.update();
    if (t >= 1) anim = null;
  }

  // Events stay on this canvas — OrbitControls must never see them, or dragging
  // the cube would orbit the model at the same time.
  const onMove = (e) => { e.stopPropagation(); showHighlight(regionAt(e)); };
  const onLeave = () => showHighlight(null);
  const onDown = (e) => { e.stopPropagation(); e.preventDefault(); };
  const onClick = (e) => {
    e.stopPropagation(); e.preventDefault();
    const d = regionAt(e);
    if (d) goTo(d);
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("click", onClick);

  // ── frame loop ──
  // The cube mirrors the main camera: same orientation, fixed distance. Its own
  // camera never moves, so the cube turns as the model turns.
  const q = new THREE.Quaternion();
  let alive = true;
  function update() {
    if (!alive) return;
    step(performance.now());
    const dir = camera.position.clone().sub(controls.target).normalize();
    // Build the cube's rotation from the main camera's basis, inverted, so the
    // face pointing at us is the one we are looking along.
    const m = new THREE.Matrix4().lookAt(dir, new THREE.Vector3(0, 0, 0), camera.up);
    q.setFromRotationMatrix(m).invert();
    cube.quaternion.copy(q);
    triad.quaternion.copy(q);
    renderer.render(scene, cam);
  }

  function dispose() {
    alive = false;
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("click", onClick);
    textures.forEach((t) => t.dispose());
    materials.forEach((m) => m.dispose());
    cube.geometry.dispose(); edges.geometry.dispose(); edges.material.dispose();
    hi.geometry.dispose(); hi.material.dispose();
    triad.children.forEach((l) => { l.geometry.dispose(); l.material.dispose(); });
    renderer.dispose();
    host.remove();
  }

  // pick() is exposed so the gizmo can be tested without synthesising pointer
  // events, and goTo() so the ribbon's view buttons and the cube can share one
  // animation path rather than two that drift apart.
  return { update, dispose, host, canvas, pick: regionAt, goTo };
}
