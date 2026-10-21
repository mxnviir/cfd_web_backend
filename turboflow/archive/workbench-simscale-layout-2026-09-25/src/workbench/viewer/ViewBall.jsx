// The orientation ball, bottom right of the viewer.
//
// This replaces the view cube that was here before. The cube was SimScale's,
// down to the six labelled faces, and it only responded to clicks: there was no
// way to take hold of it and turn the model, which is the thing people actually
// reach for a gizmo to do. Shashank's words on 11 Sep 2026: "there should be a
// movable sphere with my mouse, not just that."
//
// So: a ball you can drag. Dragging it turns the camera through the viewer's
// own orbitBy(), so it obeys the same up axis and the same target as every
// other way of turning the model. Clicking one of the six axis handles snaps to
// that view, which is the one thing the cube was good at, kept.
//
// It draws in its own scene with its own camera. Putting it in the main scene
// would make it scale with zoom, clip through the car and take the model's
// lighting.
import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { Icon } from "../icons";

/** Handle direction, which view it snaps to, and which axis colour it takes. */
const HANDLES = [
  { dir: [1, 0, 0], view: "front", axis: "x", label: "X" },
  { dir: [-1, 0, 0], view: "back", axis: "x", label: "" },
  { dir: [0, -1, 0], view: "right", axis: "y", label: "Y" },
  { dir: [0, 1, 0], view: "left", axis: "y", label: "" },
  { dir: [0, 0, 1], view: "top", axis: "z", label: "Z" },
  { dir: [0, 0, -1], view: "bottom", axis: "z", label: "" },
];

const SIZE = 112;

/** A letter on a disc, drawn to a canvas so the gizmo needs no font file. */
function handleTexture(label, fill, ink) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  if (label) {
    g.fillStyle = ink;
    // 600, not 700: workbench.html loads IBM Plex Sans at 400, 500 and 600,
    // so a 700 here was synthesised by the browser and did not match a single
    // other label on the screen.
    g.font = "600 30px 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, 32, 34);
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

export default function ViewBall({ viewer, onView, onHome }) {
  const canvas = useRef(null);

  useEffect(() => {
    if (!viewer || !canvas.current) return;
    const el = canvas.current;
    const host = el.closest(".wb") ?? document.documentElement;
    const css = getComputedStyle(host);
    const token = (name) => css.getPropertyValue(name).trim();

    // The ball wears the site's colours, like everything else in here.
    const inkColour = token("--wb-ink");
    const ruleColour = token("--wb-rule-strong");
    const panelColour = token("--wb-panel-2");
    const axisColours = {
      x: token("--wb-bad"),
      y: token("--wb-ok"),
      z: token("--wb-accent"),
    };

    const renderer = new THREE.WebGLRenderer({ canvas: el, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(SIZE, SIZE, false);

    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1.9, 1.9, 1.9, -1.9, 0.1, 20);
    cam.up.set(0, 0, 1);

    // The body of the ball: a filled sphere so the far handles are hidden
    // behind it, which is how you tell which way round it is at a glance.
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 24),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(panelColour), transparent: true, opacity: 0.9 }),
    );
    scene.add(ball);

    // Three great circles, one per axis plane, so a drag reads as rotation
    // rather than as a disc that happens to change shading.
    for (const rot of [[0, 0, 0], [Math.PI / 2, 0, 0], [0, Math.PI / 2, 0]]) {
      const ring = new THREE.LineLoop(
        new THREE.RingGeometry(1.002, 1.002, 64),
        new THREE.LineBasicMaterial({ color: new THREE.Color(ruleColour), transparent: true, opacity: 0.8 }),
      );
      ring.rotation.set(...rot);
      scene.add(ring);
    }

    const sprites = HANDLES.map((h) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: handleTexture(h.label, axisColours[h.axis], h.axis === "y" ? token("--tf-bg") : inkColour),
        depthTest: true,
        // A negative handle is a hint, not a target: dimmed so the labelled
        // ends read first.
        opacity: h.label ? 1 : 0.55,
        transparent: true,
      }));
      s.scale.setScalar(h.label ? 0.62 : 0.42);
      s.position.set(...h.dir).multiplyScalar(1.32);
      s.userData.view = h.view;
      scene.add(s);
      return s;
    });

    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const drawBall = () => {
      const dir = viewer.camera.position.clone().sub(viewer.controls.target).normalize();
      cam.position.copy(dir.multiplyScalar(6));
      cam.up.copy(viewer.camera.up);
      cam.lookAt(0, 0, 0);
      renderer.render(scene, cam);
    };
    drawBall();
    viewer.onAfterDraw = drawBall;

    // ── drag to turn, click to snap ────────────────────────────────────────
    // One pointer handler for both, told apart by how far the pointer moved:
    // under four pixels is a click, anything more was a drag and must not also
    // snap the view when the button comes up.
    let dragging = false;
    let moved = 0;
    let last = null;

    const down = (e) => {
      dragging = true;
      moved = 0;
      last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture?.(e.pointerId);
      el.classList.add("wb-ball-dragging");
      e.preventDefault();
    };
    const move = (e) => {
      if (!dragging || !last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      moved += Math.abs(dx) + Math.abs(dy);
      // Backwards on purpose: dragging the ball left turns the ball left,
      // which means the camera goes the other way round the model.
      viewer.orbitBy(-dx, -dy);
    };
    const up = (e) => {
      if (!dragging) return;
      dragging = false;
      el.releasePointerCapture?.(e.pointerId);
      el.classList.remove("wb-ball-dragging");
      if (moved > 4) return;
      const r = el.getBoundingClientRect();
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(pointer, cam);
      const hit = ray.intersectObjects(sprites, false)[0];
      if (hit) onView?.(hit.object.userData.view);
    };

    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);

    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (viewer.onAfterDraw === drawBall) viewer.onAfterDraw = null;
      sprites.forEach((s) => { s.material.map?.dispose(); s.material.dispose(); });
      ball.geometry.dispose();
      ball.material.dispose();
      renderer.dispose();
    };
  }, [viewer, onView]);

  return (
    <div className="wb-ball">
      <button type="button" className="wb-icon-btn wb-tip wb-ball-home"
        data-tip="Fit to view (A)" aria-label="Fit to view" onClick={onHome}>
        <Icon name="home" size={15} />
      </button>
      <canvas ref={canvas} width={SIZE} height={SIZE} className="wb-ball-canvas"
        aria-label="Orientation ball: drag to turn the model, click an axis to face it" />
      <div className="wb-ball-views">
        <button type="button" className="wb-ball-view" onClick={() => onView?.("iso")}>Iso</button>
        <button type="button" className="wb-ball-view" onClick={() => onView?.("front")}>Front</button>
        <button type="button" className="wb-ball-view" onClick={() => onView?.("top")}>Top</button>
      </div>
    </div>
  );
}
