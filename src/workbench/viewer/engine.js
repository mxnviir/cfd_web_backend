// The three.js side of the viewer. Build spec 6.
//
// A class rather than hooks because the render loop, the camera and the scene
// outlive every render React does, and the bug that matters here is the one
// where a re-render quietly builds a second scene and the first keeps drawing
// into the same canvas at half the frame rate.
//
// Drawing is on demand (6.8). A CFD viewer is still most of the time: the user
// reads a number, thinks, and clicks once. A permanent animation frame loop
// redrawing an unchanged car sixty times a second is a laptop fan running for
// nothing. Anything that changes the picture calls draw().
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";

// Bolt the BVH onto three's own raycast. Build spec 6.2: a plain raycast over
// 300k triangles is about 100 ms a move, which is not hover, it is lag.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** What a vertex's aSelect value means. Build spec 6.2. */
export const SEL = {
  hidden: -1, none: 0, hover: 1, selected: 2, assigned: 3, assignedOther: 4,
};

/**
 * Mouse and keyboard, per navigation preset. Build spec 6.4.
 *
 * SimScale's own bindings are the default. The other two exist because a team
 * that has spent two years in Fusion or Onshape has the rotate button in
 * their fingers, and fighting that for an hour is a real cost for no gain.
 */
export const NAV_PRESETS = {
  // TurboFlow's own default, and the reason it is not SimScale's: SimScale
  // puts pan on the middle button only, and most of the teams using this are
  // on laptops with a trackpad and no middle button at all. On those machines
  // the model could be turned and zoomed but never moved, which is what
  // "the panning controls aren't there" meant on 11 Sep 2026. Right-drag pans
  // here, the wheel zooms, and either modifier below pans from the left button.
  turboflow: { label: "TurboFlow", rotate: THREE.MOUSE.LEFT, pan: THREE.MOUSE.RIGHT, zoom: null },
  simscale: { label: "SimScale", rotate: THREE.MOUSE.LEFT, pan: THREE.MOUSE.MIDDLE, zoom: THREE.MOUSE.RIGHT },
  fusion: { label: "Fusion 360", rotate: THREE.MOUSE.MIDDLE, pan: THREE.MOUSE.MIDDLE, zoom: null },
  onshape: { label: "Onshape", rotate: THREE.MOUSE.RIGHT, pan: THREE.MOUSE.MIDDLE, zoom: null },
};

export const RENDER_MODES = ["surfaces", "surfacesEdges", "wireframe", "translucent"];

/* Every colour the viewer draws comes from the stylesheet, not from here.
 *
 * These five were hex literals copied from SimScale's palette, which meant the
 * model stayed SimScale-grey on a SimScale-white ground while the rest of the
 * product was TurboFlow dark, and no theme switch could reach them. They
 * start empty: applyTheme() fills them from the live CSS on construction and
 * again whenever the theme changes, so tokens.css is the one place each colour
 * is written down. */
const COLOURS = Object.fromEntries(
  ["base", "hover", "selected", "assigned", "assignedOther", "domain", "ground", "edge"]
    .map((k) => [k, new THREE.Color()]));

/** The token map: which CSS custom property fills which colour. */
const COLOUR_TOKENS = {
  base: "--wb-model-default",
  hover: "--wb-hover",
  selected: "--wb-selected",
  assigned: "--wb-assigned",
  assignedOther: "--wb-assigned-other",
  domain: "--wb-domain",
  ground: "--wb-viewer-bg",
  edge: "--wb-ink-3",
};


/**
 * How far back the camera goes, and how far sideways, to fit a sphere of
 * `radius` into the part of a `cw` x `ch` canvas that nothing is covering.
 *
 * Pure arithmetic, exported so it can be checked without a browser: the
 * viewer's own pixels can only be read when the window is actually painting,
 * and a pane that is behind another window reports an empty canvas whether the
 * maths is right or wrong.
 *
 * Returns the distance along the view direction, and the shift in world units
 * along the camera's right and up axes needed to move the model from the
 * middle of the canvas to the middle of the free strip.
 */
export function framing(radius, cw, ch, inset, vFov, aspect, pad = 1.15) {
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (aspect || 1));
  const { left = 0, right = 0, top = 0, bottom = 0 } = inset || {};
  // Never let a panel claim so much that the model is pushed to a speck: a
  // quarter of the canvas is the least we will try to fit into.
  const fw = Math.max(cw - left - right, cw * 0.25);
  const fh = Math.max(ch - top - bottom, ch * 0.25);
  // Where that strip starts, kept on the canvas. On a small laptop the 350px
  // settings panel can cover more of a narrow viewer than the quarter we
  // insist on fitting into, and then the strip's own centre lies off the right
  // edge: the model was framed onto pixels that do not exist.
  const fx = Math.min(Math.max(left, 0), cw - fw);
  const fy = Math.min(Math.max(top, 0), ch - fh);
  // A strip narrower than the canvas subtends a narrower angle, so the model
  // has to sit further back to fit inside it.
  const vFree = 2 * Math.atan(Math.tan(vFov / 2) * (fh / ch));
  const hFree = 2 * Math.atan(Math.tan(hFov / 2) * (fw / cw));
  const dist = Math.max(radius / Math.sin(vFree / 2), radius / Math.sin(hFree / 2)) * pad;
  // Screen x grows right and screen y grows down; moving the camera right
  // moves the model left, hence the sign on dx but not on dy.
  const perPx = (2 * dist * Math.tan(vFov / 2)) / ch;
  return {
    dist,
    dx: -((fx + fw / 2) - cw / 2) * perPx,
    dy: ((fy + fh / 2) - ch / 2) * perPx,
  };
}

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    /**
     * Parts of the canvas that something is sitting on top of, in CSS pixels.
     *
     * The settings panel floats over the left 362px of the viewer and the job
     * drawer over the bottom of it. Fit to view knew nothing about either, so
     * it centred the car in the whole canvas and put it squarely behind the
     * panel: on a 1280px window the free strip is 263px wide and the model was
     * centred 390px to the left of it. Set by the Viewer, which can see where
     * the panels actually are.
     */
    this.inset = { left: 0, right: 0, top: 0, bottom: 0 };
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false,
      // Needed for screenshots (12.7). Without it the buffer is cleared
      // before toDataURL can read it and every screenshot comes out black.
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.applyTheme();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.001, 1000);
    this.camera.position.set(0.6, -0.6, 0.35);
    this.camera.up.set(0, 0, 1);

    this.controls = new OrbitControls(this.camera, canvas);
    // Damping off, against the spec's 0.1, on the owner's explicit direction:
    // "it has too much smoothness, it should be snappy". With damping the
    // model keeps drifting after the mouse stops, which reads as lag rather
    // than polish and turns lining a section plane up by eye into a chase.
    this.controls.enableDamping = false;
    this.controls.rotateSpeed = 0.9;
    this.controls.zoomSpeed = 1.1;
    this.controls.panSpeed = 0.9;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener("change", () => this.draw());
    this.setNav("turboflow");
    this.bindModifierPan();

    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(1, -1, 1.4);
    this.camera.add(key);
    this.scene.add(this.camera);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    // Made after applyTheme() has run once, so it takes the ground colour here;
    // a literal grey stayed until the first theme switch.
    this.hemi = new THREE.HemisphereLight(0xffffff, COLOURS.ground, 0.7);
    this.scene.add(this.hemi);

    this.model = null;
    this.mesh = null;
    this.faces = [];              // faces.json entries, index === face id
    this.adjacency = [];
    this.faceOfVertex = null;     // Float32Array, the _FACEID attribute
    this.selectAttr = null;
    this.needsDraw = true;
    this.disposed = false;
    this.axisLock = null;         // "x" | "y" | "z" while that key is held

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.pointer = new THREE.Vector2();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement || canvas);
    this.resize();

    const tick = () => {
      if (this.disposed) return;
      if (this.needsDraw) {
        this.needsDraw = false;
        this.renderer.render(this.scene, this.camera);
        this.onAfterDraw?.();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  draw() { this.needsDraw = true; }

  setNav(name) {
    const preset = NAV_PRESETS[name] || NAV_PRESETS.turboflow;
    this.nav = name;
    this.buttons = {
      LEFT: preset.rotate,
      MIDDLE: preset.pan ?? THREE.MOUSE.PAN,
      RIGHT: preset.zoom ?? preset.pan ?? preset.rotate,
    };
    this.controls.mouseButtons = { ...this.buttons };
    this.draw();
  }

  /**
   * Pan from the left button while a modifier is held.
   *
   * OrbitControls has no notion of modifiers: it reads mouseButtons once, at
   * pointerdown. So the binding is swapped in a capture-phase listener that
   * runs before its own, and swapped back when the drag ends. Ctrl, Shift and
   * Cmd all pan, because which one a person reaches for depends entirely on
   * the CAD package they learned first, and there is nothing else for them to
   * do here.
   */
  bindModifierPan() {
    const el = this.canvas;
    const down = (e) => {
      if (e.button !== 0) return;
      if (!(e.ctrlKey || e.shiftKey || e.metaKey)) return;
      this.controls.mouseButtons = { ...this.buttons, LEFT: THREE.MOUSE.PAN };
    };
    const restore = () => { this.controls.mouseButtons = { ...this.buttons }; };
    el.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", restore);
    // The context menu has to go, or right-drag to pan opens it on release.
    const noMenu = (e) => e.preventDefault();
    el.addEventListener("contextmenu", noMenu);
    this.unbindNav = () => {
      el.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", restore);
      el.removeEventListener("contextmenu", noMenu);
    };
  }

  /**
   * Turn the camera by a screen-space drag, for the orientation ball.
   *
   * Spherical coordinates assume Y is up and this scene is Z up, so the
   * rotation is done as two axis-angle turns instead: around the camera's own
   * up vector for the horizontal drag, and around its right vector for the
   * vertical one. The clamp stops the model flipping over at the poles, which
   * is the one thing a trackball must not do.
   */
  orbitBy(dx, dy) {
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const up = this.camera.up.clone().normalize();
    const right = new THREE.Vector3().crossVectors(up, offset).normalize();
    if (right.lengthSq() < 1e-8) return;

    offset.applyAxisAngle(up, -dx * 0.01);
    const turned = offset.clone().applyAxisAngle(right, -dy * 0.01);
    const angle = turned.angleTo(up);
    if (angle > 0.05 && angle < Math.PI - 0.05) offset.copy(turned);

    this.camera.position.copy(target).add(offset);
    this.camera.lookAt(target);
    this.controls.update();
    this.draw();
  }

  resize() {
    const box = this.canvas.parentElement || this.canvas;
    const w = box.clientWidth || 1;
    const h = box.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  // ── loading ───────────────────────────────────────────────────────────────
  /**
   * Load a GLB and its face list.
   *
   * Draco is deliberately not enabled (6.8). It reorders vertices, and the
   * field binaries a run produces are one float per vertex in the GLB's own
   * order, so a Draco pass would silently paint the pressure field onto the
   * wrong parts of the car.
   */
  async load(url, faces = [], adjacency = [], scaleToM = 1) {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.clear();

    const root = gltf.scene;
    let mesh = null;
    root.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
    if (!mesh) throw new Error("that model has no mesh in it");

    const geo = mesh.geometry;
    geo.computeVertexNormals();
    geo.computeBoundsTree();

    const count = geo.getAttribute("position").count;
    // GLTFLoader lowercases custom attribute names, so the _FACEID the
    // geometry service writes arrives as _faceid. Both are checked because
    // the name is the one thread holding picking together: without it a
    // click gives a triangle index and nothing can turn that into a face.
    const faceAttr = geo.getAttribute("_FACEID") || geo.getAttribute("_faceid");
    if (!faceAttr) throw new Error("that model carries no face ids, so nothing can be picked");
    this.faceOfVertex = faceAttr.array;

    this.selectAttr = new THREE.BufferAttribute(new Float32Array(count), 1);
    geo.setAttribute("aSelect", this.selectAttr);

    mesh.material = this.makeMaterial(!!geo.getAttribute("color"));

    /*
     * Put the scene in metres.
     *
     * The GLB comes out of the geometry service in the file's own units,
     * usually millimetres, while faces.json is in metres because everything
     * stored is SI (build spec 3.5). Left alone the two disagree by a factor
     * of a thousand, and the first thing that breaks is box select: it
     * projects each face's bounding box, which lands somewhere off the edge
     * of the screen, so a box over the whole car selects nothing at all and
     * says nothing about why.
     *
     * Scaling the root rather than rewriting the vertex buffer keeps the
     * vertex order the field binaries depend on, and costs one matrix.
     */
    root.scale.setScalar(scaleToM || 1);
    root.updateMatrixWorld(true);
    this.scaleToM = scaleToM || 1;
    this.model = root;
    this.mesh = mesh;
    this.faces = faces;
    this.adjacency = adjacency;
    this.scene.add(root);
    this.frame();
    return mesh;
  }

  /**
   * The four numbers the measure tool shows for a pair of faces, from the
   * model already on the GPU.
   *
   * This used to be a round trip to the geometry service, which asked OCC for
   * the exact distance between the two B-rep faces. The browser engine has
   * no such call, so the distance here is measured between the meshes: every
   * vertex of one face against the surface of the other, both ways round. On
   * the pairs a designer actually measures - flat panels - the closest point
   * lies inside a triangle and the answer is exact; on tight curves it can
   * read a mesh deflection (a tenth of a millimetre) high, which is the cost
   * of doing this locally and instantly rather than shipping the STEP to a
   * container.
   *
   * The rest is arithmetic on the face survey, which was always exact: the
   * far corner is the bounding-box extremum every CAD package reports, and
   * the angle and the along-normal gap only exist for two planes.
   */
  measurePair(a, b) {
    const geo = this.mesh?.geometry;
    if (!geo) throw new Error("There is no model loaded to measure.");
    const faces = this.faces ?? [];
    const fa = faces[a], fb = faces[b];
    if (!fa || !fb) throw new Error("No such face on this model.");
    if (a === b) throw new Error("Those are the same face.");

    const round9 = (v) => Math.round(v * 1e9) / 1e9;
    const out = { min_distance_m: 0, max_distance_m: 0 };

    // The far corner, exactly as the service computed it: the extremum of
    // the two bounding boxes, not a second geometric pass, because the far
    // extremum is not well defined on curved surfaces.
    let largest = -Infinity;
    for (const k1 of ["min", "max"]) {
      for (const k2 of ["min", "max"]) {
        const p = fa.bbox[k1], q = fb.bbox[k2];
        largest = Math.max(largest,
          Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
      }
    }
    out.max_distance_m = round9(largest);

    // Two planes: the angle between them and the distance along the normal.
    // Meaningingless for anything curved, so only said when both are planes.
    if (Array.isArray(fa.normal) && Array.isArray(fb.normal)) {
      const dot = Math.max(-1, Math.min(1,
        fa.normal[0] * fb.normal[0] + fa.normal[1] * fb.normal[1]
        + fa.normal[2] * fb.normal[2]));
      out.angle_deg = Math.round(Math.acos(Math.abs(dot)) * 180 / Math.PI * 1e4) / 1e4;
      const gap = [
        (fb.cx_m ?? 0) - (fa.cx_m ?? 0),
        (fb.cy_m ?? 0) - (fa.cy_m ?? 0),
        (fb.cz_m ?? 0) - (fa.cz_m ?? 0),
      ];
      out.normal_distance_m = round9(Math.abs(
        gap[0] * fa.normal[0] + gap[1] * fa.normal[1] + gap[2] * fa.normal[2]));
    }

    // The closest approach, vertex to surface, both ways. The vertices of a
    // face are one contiguous run of the buffer and its triangles one
    // contiguous run of the index, which is what makes a face-sized
    // sub-geometry cheap to cut out.
    const pos = geo.getAttribute("position");
    const index = geo.index;
    if (!index) throw new Error("This model has no face list to measure.");
    const subBvh = (f) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(
        pos.array.subarray(f.start * 3, (f.start + f.count) * 3), 3));
      // Uint32: a big body face can hold more vertices than 16 bits address.
      const tris = new Uint32Array(f.tri_count * 3);
      for (let t = 0; t < f.tri_count * 3; t++) tris[t] = index.array[f.tri_start * 3 + t] - f.start;
      g.setIndex(new THREE.BufferAttribute(tris, 1));
      g.computeBoundsTree();
      return g;
    };
    const bvhA = subBvh(fa), bvhB = subBvh(fb);
    const target = { distance: Infinity };
    let best = Infinity;
    const nearest = (v, bvh) => {
      target.distance = Infinity;
      bvh.closestPointToPoint(v, target);
      return target.distance;
    };
    const v = new THREE.Vector3();
    for (let i = fa.start; i < fa.start + fa.count; i++) {
      v.fromBufferAttribute(pos, i);
      best = Math.min(best, nearest(v, bvhB));
    }
    for (let i = fb.start; i < fb.start + fb.count; i++) {
      v.fromBufferAttribute(pos, i);
      best = Math.min(best, nearest(v, bvhA));
    }
    bvhA.disposeBoundsTree();
    bvhB.disposeBoundsTree();
    bvhA.dispose();
    bvhB.dispose();
    out.min_distance_m = round9(best * (this.scaleToM || 1));
    return out;
  }

  /**
   * The wind tunnel, drawn as glass.
   *
   * A second draw of the same geometry with the test reversed: the car pass
   * discards the walls, this one discards everything else. Two passes rather
   * than one transparent material over the whole model, because a single
   * transparent pass has to choose between writing depth - which hides the car
   * behind the glass in front of it - and not writing it, which lets the far
   * wall paint over the near one. Drawing the opaque car first and blending
   * the glass after it, with renderOrder, is the arrangement that has neither
   * problem and it costs one extra draw call on geometry already uploaded.
   */
  /**
   * The wind tunnel, drawn as a translucent box around the car.
   *
   * A box, not the flow region. The thing the solver is given is the negative
   * - a block with the car subtracted out of it - and for a while this drew
   * that, painting its six outer walls see-through so the cavity showed. What
   * you got was the inside of a car-shaped hole, which is not a car and is not
   * what anybody wants to look at.
   *
   * So the viewer loads the car, and the tunnel is six rectangles drawn from
   * the numbers /prepare already worked out. The car looks like a car, the
   * tunnel looks like glass around it, and neither is pretending to be the
   * other.
   *
   * `domain` is in metres, and so is the scene - the model root is scaled by
   * scale_to_m at load - so these go in unconverted.
   */
  setTunnel(domain) {
    this.disposeTunnel();
    if (!domain) { this.draw(); return; }

    const x0 = Math.min(domain.outlet_x, domain.inlet_x);
    const x1 = Math.max(domain.outlet_x, domain.inlet_x);
    const y0 = Math.min(domain.side_y, domain.symmetry_y);
    const y1 = Math.max(domain.side_y, domain.symmetry_y);
    const z0 = Math.min(domain.ground_z, domain.top_z);
    const z1 = Math.max(domain.ground_z, domain.top_z);
    const w = x1 - x0, d = y1 - y0, h = z1 - z0;
    if (!(w > 0 && d > 0 && h > 0)) { this.draw(); return; }

    const geo = new THREE.BoxGeometry(w, d, h);
    geo.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);

    const glass = new THREE.MeshStandardMaterial({
      color: COLOURS.domain,
      metalness: 0,
      roughness: 0.6,
      transparent: true,
      opacity: 0.09,
      // Never occludes the car: the inlet is a square metre and a half of
      // glass between the camera and a 240 mm model.
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const box = new THREE.Mesh(geo, glass);
    box.renderOrder = 2;
    box.raycast = () => {};

    // An outline, so it reads as a box rather than a haze.
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({
        color: COLOURS.domain, transparent: true, opacity: 0.5,
      }),
    );
    edges.renderOrder = 3;
    edges.raycast = () => {};

    this.tunnel = new THREE.Group();
    this.tunnel.add(box, edges);
    this.tunnel.visible = this.tunnelOn !== false;
    this.scene.add(this.tunnel);
    this.hasTunnel = true;
    this.draw();
  }

  setTunnelVisible(on) {
    this.tunnelOn = !!on;
    if (this.tunnel) this.tunnel.visible = this.tunnelOn;
    this.draw();
  }

  disposeTunnel() {
    if (!this.tunnel) return;
    this.tunnel.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    this.scene.remove(this.tunnel);
    this.tunnel = null;
    this.hasTunnel = false;
  }

  /**
   * The model material, with the highlight shader spliced in.
   *
   * One float per vertex decides its colour, so highlighting a face is a
   * write into a range of that array and one needsUpdate. Build spec 6.2 is
   * explicit that geometry is never rebuilt to highlight or hide, and this is
   * why: a car has 2219 faces and hover fires every 16 ms.
   */
  makeMaterial(hasVertexColours) {
    const m = new THREE.MeshStandardMaterial({
      color: COLOURS.base, metalness: 0.1, roughness: 0.8,
      side: THREE.DoubleSide, flatShading: false,
      // Only when the attribute is actually there: turning this on without a
      // COLOR_0 renders the whole car black.
      vertexColors: hasVertexColours,
    });

    m.onBeforeCompile = (shader) => {
      shader.uniforms.uHover = { value: COLOURS.hover };
      shader.uniforms.uSelected = { value: COLOURS.selected };
      shader.uniforms.uAssigned = { value: COLOURS.assigned };
      shader.uniforms.uAssignedOther = { value: COLOURS.assignedOther };

      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
          attribute float aSelect;
          varying float vSelect;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          vSelect = aSelect;`);

      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying float vSelect;
          uniform vec3 uHover;
          uniform vec3 uSelected;
          uniform vec3 uAssigned;
          uniform vec3 uAssignedOther;`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          // A hidden face is discarded rather than made transparent: a
          // transparent one still writes depth and hides what is behind it,
          // which is the opposite of what Hide is for.
          if (vSelect < -0.5) discard;
          if (vSelect > 3.5)      diffuseColor.rgb = uAssignedOther;
          else if (vSelect > 2.5) diffuseColor.rgb = uAssigned;
          else if (vSelect > 1.5) diffuseColor.rgb = uSelected;
          else if (vSelect > 0.5) diffuseColor.rgb = uHover;`);
    };
    return m;
  }

  clear() {
    if (!this.model) return;
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.disposeBoundsTree?.();
      o.geometry?.dispose();
      o.material?.dispose();
    });
    this.scene.remove(this.model);
    this.model = null;
    this.mesh = null;
    this.faces = [];
    this.selectAttr = null;
    this.faceOfVertex = null;
    this.disposeEdges();
    this.draw();
  }

  // ── a run's results on the car ────────────────────────────────────────────
  /**
   * The solver's surface, coloured by one field.
   *
   * results.glb is the car as the solver saw it, and each field binary holds
   * one float per vertex of it, in the same order, so colouring is a straight
   * walk down both arrays. It is drawn instead of the model, not over it: the
   * two are different meshes of the same car and would fight for the same
   * pixels. hideField puts the model back as it was.
   *
   * `stops` are colours from `lo` to `hi`; values outside the range take the
   * end colour. Loading is skipped when the same surface is already showing,
   * so switching field only recolours.
   */
  async showField(url, values, stops, lo, hi) {
    if (this.fieldUrl !== url) {
      this.hideField();
      const gltf = await new GLTFLoader().loadAsync(url);
      let mesh = null;
      gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
      if (!mesh) throw new Error("the results have no surface in them");
      mesh.geometry.computeVertexNormals();
      mesh.material = new THREE.MeshStandardMaterial({
        vertexColors: true, metalness: 0, roughness: 0.9, side: THREE.DoubleSide,
      });
      this.fieldModel = gltf.scene;
      this.fieldMesh = mesh;
      this.fieldUrl = url;
      this.scene.add(gltf.scene);
      if (this.model) this.model.visible = false;
      this.frame(new THREE.Box3().setFromObject(gltf.scene));
    }
    const geo = this.fieldMesh.geometry;
    const n = geo.getAttribute("position").count;
    if (values.length !== n) {
      throw new Error(`this field has ${values.length} values for a surface of ${n} points`);
    }
    const ramp = stops.map((s) => new THREE.Color(s));
    const last = ramp.length - 1;
    const span = hi - lo || 1;
    const out = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, Math.max(0, (values[i] - lo) / span)) * last;
      const k = Math.min(last - 1, Math.floor(t));
      c.copy(ramp[k]).lerp(ramp[k + 1], t - k);
      out[3 * i] = c.r; out[3 * i + 1] = c.g; out[3 * i + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(out, 3));
    this.draw();
  }

  hideField() {
    if (!this.fieldModel) return;
    this.scene.remove(this.fieldModel);
    this.fieldModel.traverse((o) => {
      if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
    });
    this.fieldModel = this.fieldMesh = this.fieldUrl = null;
    if (this.model) this.model.visible = true;
    this.draw();
  }

  // ── highlighting ──────────────────────────────────────────────────────────
  /** Write one state value over the vertex ranges of these faces. */
  paint(faceIds, value) {
    if (!this.selectAttr) return;
    const a = this.selectAttr.array;
    for (const id of faceIds) {
      const f = this.faces[id];
      if (!f || !f.count) continue;
      a.fill(value, f.start, f.start + f.count);
    }
    this.selectAttr.needsUpdate = true;
    this.syncEdges();
    this.draw();
  }

  /**
   * Repaint everything from the current state in one pass.
   *
   * Cheaper than it looks and much safer than incremental updates: a fill
   * over 70000 floats is microseconds, and the alternative is tracking what
   * the previous hover was so it can be cleared, which is where the stuck
   * blue face comes from.
   */
  applyStates({ selected = [], hover = [], assigned = [], assignedOther = [], hidden = [] }) {
    if (!this.selectAttr) return;
    this.selectAttr.array.fill(SEL.none);
    this.paintQuiet(assigned, SEL.assigned);
    this.paintQuiet(assignedOther, SEL.assignedOther);
    this.paintQuiet(selected, SEL.selected);
    this.paintQuiet(hover, SEL.hover);
    this.paintQuiet(hidden, SEL.hidden);
    this.selectAttr.needsUpdate = true;
    this.syncEdges();
    this.draw();
  }

  paintQuiet(faceIds, value) {
    if (!this.selectAttr) return;
    const a = this.selectAttr.array;
    for (const id of faceIds) {
      const f = this.faces[id];
      if (!f || !f.count) continue;
      a.fill(value, f.start, f.start + f.count);
    }
  }

  // ── picking ───────────────────────────────────────────────────────────────
  /** Normalised device coordinates for a pointer event. */
  ndc(event) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((event.clientY - r.top) / r.height) * 2 + 1;
    return this.pointer;
  }

  /** The face under the pointer, or null. */
  pick(event) {
    if (!this.mesh || !this.faceOfVertex) return null;
    this.raycaster.firstHitOnly = true;
    this.raycaster.setFromCamera(this.ndc(event), this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit) return null;
    const face = this.faceOfVertex[hit.face.a];
    return { face, point: hit.point.clone(), distance: hit.distance };
  }

  /**
   * Every face along the ray, nearest first. Feeds "Select other" (6.3).
   *
   * firstHitOnly is turned off for exactly this query and back on after: it
   * is the whole reason hover is affordable, and leaving it off would make
   * every pointer move walk the entire model.
   */
  pickAll(event, limit = 8) {
    if (!this.mesh || !this.faceOfVertex) return [];
    this.raycaster.firstHitOnly = false;
    this.raycaster.setFromCamera(this.ndc(event), this.camera);
    const hits = this.raycaster.intersectObject(this.mesh, false);
    this.raycaster.firstHitOnly = true;
    const seen = new Set();
    const out = [];
    for (const h of hits) {
      const id = this.faceOfVertex[h.face.a];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ face: id, point: h.point.clone(), distance: h.distance });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Faces inside a screen rectangle.
   *
   * Direction matters, as it does in every CAD package: dragging left to
   * right takes only what is wholly inside, right to left takes anything the
   * box touches. Each face is tested by its eight bounding box corners rather
   * than its triangles, which is 8 projections instead of thousands.
   */
  boxSelect(x0, y0, x1, y1) {
    if (!this.mesh || !this.faces.length) return [];
    const crossing = x1 < x0;
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    const r = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector3();
    const out = [];

    for (let i = 0; i < this.faces.length; i += 1) {
      const f = this.faces[i];
      if (!f?.bbox || !f.count) continue;
      const { min, max } = f.bbox;
      let inside = 0;
      let sx0 = Infinity;
      let sy0 = Infinity;
      let sx1 = -Infinity;
      let sy1 = -Infinity;
      for (let c = 0; c < 8; c += 1) {
        v.set(c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]);
        v.project(this.camera);
        const sx = r.left + ((v.x + 1) / 2) * r.width;
        const sy = r.top + ((1 - v.y) / 2) * r.height;
        sx0 = Math.min(sx0, sx); sx1 = Math.max(sx1, sx);
        sy0 = Math.min(sy0, sy); sy1 = Math.max(sy1, sy);
        if (sx >= left && sx <= right && sy >= top && sy <= bottom) inside += 1;
      }
      if (crossing) {
        const overlaps = sx1 >= left && sx0 <= right && sy1 >= top && sy0 <= bottom;
        if (overlaps) out.push(i);
      } else if (inside === 8) {
        out.push(i);
      }
    }
    return out;
  }

  // ── expanding a selection ────────────────────────────────────────────────
  /** Flood fill across joins smoother than `degrees`. Build spec 6.3. */
  tangentFaces(seed, degrees = 5) {
    const near = new Map();
    for (const [a, b, angle] of this.adjacency) {
      if (angle > degrees) continue;
      if (!near.has(a)) near.set(a, []);
      if (!near.has(b)) near.set(b, []);
      near.get(a).push(b);
      near.get(b).push(a);
    }
    const seen = new Set(seed);
    const queue = [...seed];
    while (queue.length) {
      for (const n of near.get(queue.pop()) || []) {
        if (seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return [...seen];
  }

  /** Faces whose area is within 0.5% of any selected one. */
  sameArea(seed, tolerance = 0.005) {
    const wanted = seed.map((i) => this.faces[i]?.area_m2).filter((a) => a > 0);
    if (!wanted.length) return seed;
    const out = new Set(seed);
    this.faces.forEach((f, i) => {
      if (!(f?.area_m2 > 0)) return;
      if (wanted.some((w) => Math.abs(f.area_m2 - w) <= w * tolerance)) out.add(i);
    });
    return [...out];
  }

  /** Round faces whose radius is within 0.5% of any selected one. */
  sameRadius(seed, tolerance = 0.005) {
    const wanted = seed.map((i) => this.faces[i]?.radius_m).filter((r) => r > 0);
    if (!wanted.length) return seed;
    const out = new Set(seed);
    this.faces.forEach((f, i) => {
      if (!(f?.radius_m > 0)) return;
      if (wanted.some((w) => Math.abs(f.radius_m - w) <= w * tolerance)) out.add(i);
    });
    return [...out];
  }

  /** Every face of the solids these faces belong to. */
  facesOfSolids(seed) {
    const solids = new Set(seed.map((i) => this.faces[i]?.solid).filter((s) => s != null));
    const out = [];
    this.faces.forEach((f, i) => { if (solids.has(f?.solid)) out.push(i); });
    return out;
  }

  // ── camera ────────────────────────────────────────────────────────────────
  bounds() {
    if (!this.model) return null;
    return new THREE.Box3().setFromObject(this.model);
  }

  /**
   * Re-read every colour from the stylesheet.
   *
   * Called once at construction and again when the theme changes, so the
   * viewer follows the site instead of keeping a palette of its own. Reading
   * from getComputedStyle means there is exactly one place each colour is
   * written down, which is tokens.css.
   */
  applyTheme() {
    const host = this.canvas?.closest(".wb") ?? document.documentElement;
    const css = getComputedStyle(host);
    const read = (token, fallback) => {
      const v = css.getPropertyValue(token).trim();
      if (!v) return fallback;
      try { return new THREE.Color(v); } catch { return fallback; }
    };
    // Mutated in place, never replaced. The shader uniforms hold references to
    // these very objects, so assigning a new Color would leave every material
    // pointing at the old one and only the clear colour would change.
    for (const [key, token] of Object.entries(COLOUR_TOKENS)) {
      COLOURS[key].copy(read(token, COLOURS[key]));
    }
    const ground = COLOURS.ground;
    this.renderer.setClearColor(ground, 1);
    // The bounce light carries the ground colour, so a model on a dark ground
    // is lit like one: without this the underside stays SimScale-grey and the
    // car looks pasted onto the background.
    if (this.hemi) this.hemi.groundColor.copy(ground);
    if (this.edgeMaterial) {
      this.edgeMaterial.color.copy(COLOURS.edge);
    }
    // The base colour is copied into each material when it is made, so those
    // copies have to be told as well.
    //
    // Except the tunnel. It is a child of the car mesh, so this walk reaches
    // it, and painting it the car's colour is how a piece of glass becomes an
    // opaque grey box with the car sealed inside it.
    for (const root of [this.model, this.mesh]) {
      root?.traverse?.((o) => {
        if (o.isMesh && o.material && o.material.color && !o.material.isLineBasicMaterial) {
          o.material.color.copy(COLOURS.base);
        }
      });
    }
    if (this.tunnel) {
      this.tunnel.traverse((o) => o.material?.color?.copy(COLOURS.domain));
    }
    this.draw();
  }

  /** The bounding box of a set of faces, for Fit to selection. */
  boundsOf(faceIds) {
    const box = new THREE.Box3();
    let any = false;
    for (const id of faceIds) {
      const f = this.faces[id];
      if (!f?.bbox) continue;
      box.expandByPoint(new THREE.Vector3(...f.bbox.min));
      box.expandByPoint(new THREE.Vector3(...f.bbox.max));
      any = true;
    }
    return any ? box : null;
  }

  frame(box = this.bounds()) {
    if (!box || box.isEmpty()) return;
    // Where the panels are right now, not where they were when this was built.
    this.measureInset?.();
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-6);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    // Both fields of view, not just the vertical one.
    //
    // radius / sin(vFov / 2) fits the bounding sphere top to bottom and says
    // nothing about left to right. The Workbench viewport is often taller than
    // it is wide (a 623 x 714 canvas between two panels), and there the
    // horizontal field is the narrower of the two, so a 2.2 m car framed by
    // the vertical fov alone ran off both sides of the screen. Take whichever
    // distance is larger and the whole model is inside both.
    const vFov = (this.camera.fov * Math.PI) / 180;
    const { dist, dx, dy } = framing(
      radius, this.canvas?.clientWidth || 1, this.canvas?.clientHeight || 1,
      this.inset, vFov, this.camera.aspect);

    this.controls.target.copy(centre);
    this.camera.position.copy(centre).addScaledVector(dir, dist);

    // Slide the camera so the model lands in the middle of the free strip
    // rather than the middle of the canvas.
    if (dx || dy) {
      this.camera.updateMatrixWorld();
      const shift = new THREE.Vector3()
        .setFromMatrixColumn(this.camera.matrixWorld, 0).multiplyScalar(dx)
        .addScaledVector(new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1), dy);
      this.camera.position.add(shift);
      this.controls.target.add(shift);
    }
    // Near and far from the bounding sphere, per 6.4. A fixed 0.001 near
    // plane on a 0.2 m car throws away most of the depth buffer and surfaces
    // that are close together flicker against each other.
    this.camera.near = Math.max(radius / 1000, 1e-6);
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.draw();
  }

  /**
   * Tell the viewer which edges of the canvas are covered, in CSS pixels.
   * Returns true when anything changed, so the caller can re-fit.
   */
  setInset(next) {
    const merged = { ...this.inset, ...next };
    const same = Object.keys(merged).every((k) => Math.abs(merged[k] - this.inset[k]) < 1);
    this.inset = merged;
    return !same;
  }

  /** Put the orbit centre at a point on the model. Build spec 6.4. */
  setRotationCentre(point) {
    const shift = point.clone().sub(this.controls.target);
    this.controls.target.copy(point);
    this.camera.position.add(shift);
    this.controls.update();
    this.draw();
  }

  setView(name, animate = true) {
    const dirs = {
      front: [1, 0, 0], back: [-1, 0, 0],
      right: [0, -1, 0], left: [0, 1, 0],
      top: [0, 0, 1], bottom: [0, 0, -1],
      iso: [0.8, -0.8, 0.6],
    };
    const d = dirs[name] || dirs.iso;
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target);
    const to = target.clone().add(new THREE.Vector3(...d).normalize().multiplyScalar(dist));
    if (!animate) {
      this.camera.position.copy(to);
      this.controls.update();
      this.draw();
      return;
    }
    // An animation cannot run on a hidden page: requestAnimationFrame is
    // paused outright, so a view change started just before the user switches
    // tab would leave the camera stranded part of the way there and stay that
    // way until they came back and nudged it. Jump straight to the end.
    if (document.hidden) {
      this.camera.position.copy(to);
      this.controls.update();
      this.draw();
      return;
    }
    const from = this.camera.position.clone();
    const t0 = performance.now();
    const step = () => {
      if (this.disposed) return;
      // Same reason, for a tab hidden while the animation is already running.
      if (document.hidden) {
        this.camera.position.copy(to);
        this.controls.update();
        this.draw();
        return;
      }
      const p = Math.min(1, (performance.now() - t0) / 300);
      const e = p * p * (3 - 2 * p);            // smootherstep, per 5.9
      this.camera.position.copy(from).lerp(to, e);
      this.controls.update();
      this.draw();
      if (p < 1) requestAnimationFrame(step);
    };
    step();
  }

  /**
   * Lock rotation to one axis while X, Y or Z is held. Build spec 6.4.
   *
   * OrbitControls has no such mode, so it is done by clamping: with the axis
   * locked, only the matching angle is allowed to change, which the controls'
   * min/max angle limits express directly.
   */
  setAxisLock(axis) {
    this.axisLock = axis;
    const c = this.controls;
    if (!axis) {
      c.minPolarAngle = 0;
      c.maxPolarAngle = Math.PI;
      c.minAzimuthAngle = -Infinity;
      c.maxAzimuthAngle = Infinity;
      return;
    }
    // Z is the up axis here, so a lock on Z means "spin about up": the polar
    // angle is pinned and the azimuth is free. X and Y are the other way.
    if (axis === "z") {
      const polar = c.getPolarAngle();
      c.minPolarAngle = polar;
      c.maxPolarAngle = polar;
      c.minAzimuthAngle = -Infinity;
      c.maxAzimuthAngle = Infinity;
    } else {
      const azimuth = c.getAzimuthalAngle();
      c.minAzimuthAngle = azimuth;
      c.maxAzimuthAngle = azimuth;
      c.minPolarAngle = 0;
      c.maxPolarAngle = Math.PI;
    }
  }

  // ── display ───────────────────────────────────────────────────────────────
  setRenderMode(mode) {
    if (!this.mesh) return;
    const m = this.mesh.material;
    m.wireframe = mode === "wireframe";
    m.transparent = mode === "translucent";
    m.opacity = mode === "translucent" ? 0.35 : 1;
    m.depthWrite = mode !== "translucent";
    m.needsUpdate = true;
    this.setEdges(mode === "surfacesEdges" || mode === "wireframe");
    this.draw();
  }

  /**
   * The thin dark lines along the model's real edges.
   *
   * Not a wireframe: a wireframe draws every triangle edge, and on an 83000
   * triangle car that is a grey smear. Only the edges where two triangles
   * meet at more than 30 degrees, plus the boundary of each face, which is
   * what "Surfaces with edges" actually shows.
   *
   * Built here rather than with THREE.EdgesGeometry for one reason:
   * EdgesGeometry throws away which face each line came from, so hiding a
   * body left its outline hanging in mid air. Walking the triangles face by
   * face costs a couple of hundred milliseconds once, at load, and gives
   * every line vertex a face id so the same aSelect attribute can discard it.
   */
  buildEdges() {
    const geo = this.mesh.geometry;
    const pos = geo.getAttribute("position").array;
    const idx = geo.index ? geo.index.array : null;
    const tri = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k);
    const verts = [];
    const owners = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n1 = new THREE.Vector3();
    const n2 = new THREE.Vector3();
    const COS30 = Math.cos((30 * Math.PI) / 180);

    const normalOf = (t, out) => {
      const i0 = tri(t, 0) * 3;
      const i1 = tri(t, 1) * 3;
      const i2 = tri(t, 2) * 3;
      a.set(pos[i0], pos[i0 + 1], pos[i0 + 2]);
      b.set(pos[i1], pos[i1 + 1], pos[i1 + 2]);
      c.set(pos[i2], pos[i2 + 1], pos[i2 + 2]);
      return out.copy(b).sub(a).cross(c.clone().sub(a)).normalize();
    };

    for (let f = 0; f < this.faces.length; f += 1) {
      const face = this.faces[f];
      if (!face?.tri_count) continue;
      const start = face.tri_start;
      const end = start + face.tri_count;
      // Edge key to the one or two triangles that use it. Within a face the
      // vertices are shared, so this finds real neighbours; between faces
      // they are not, which is why every face boundary comes out as an edge.
      const edges = new Map();
      for (let t = start; t < end; t += 1) {
        for (let k = 0; k < 3; k += 1) {
          const v0 = tri(t, k);
          const v1 = tri(t, (k + 1) % 3);
          const key = v0 < v1 ? `${v0},${v1}` : `${v1},${v0}`;
          const seen = edges.get(key);
          if (seen) seen.push(t); else edges.set(key, [t]);
        }
      }
      for (const [key, ts] of edges) {
        let keep = ts.length === 1;                 // a boundary of the face
        if (!keep) {
          normalOf(ts[0], n1);
          normalOf(ts[1], n2);
          keep = n1.dot(n2) < COS30;                // a crease sharper than 30
        }
        if (!keep) continue;
        const [v0, v1] = key.split(",").map(Number);
        verts.push(pos[v0 * 3], pos[v0 * 3 + 1], pos[v0 * 3 + 2]);
        verts.push(pos[v1 * 3], pos[v1 * 3 + 1], pos[v1 * 3 + 2]);
        owners.push(f, f);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    this.edgeSelect = new THREE.BufferAttribute(new Float32Array(owners.length), 1);
    g.setAttribute("aSelect", this.edgeSelect);
    this.edgeFace = owners;

    const m = new THREE.LineBasicMaterial({
      color: COLOURS.edge,
      transparent: true, opacity: 0.6,
    });
    this.edgeMaterial = m;
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\n attribute float aSelect;\n varying float vSelect;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\n vSelect = aSelect;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\n varying float vSelect;")
        .replace("#include <clipping_planes_fragment>",
          "#include <clipping_planes_fragment>\n if (vSelect < -0.5) discard;");
    };
    return new THREE.LineSegments(g, m);
  }

  /**
   * Show or hide the edge overlay, building it at most once per model.
   *
   * Rebuilding took 306 ms on the sample car, and the render mode menu
   * toggles this every time somebody looks at Wireframe and changes their
   * mind. Visibility is free; the walk over 83000 triangles is not.
   */
  setEdges(on) {
    if (on && !this.edges && this.mesh) {
      this.edges = this.buildEdges();
      this.mesh.add(this.edges);
      this.syncEdges();
    }
    if (this.edges) this.edges.visible = !!on;
    this.draw();
  }

  disposeEdges() {
    if (!this.edges) return;
    this.edges.parent?.remove(this.edges);
    this.edges.geometry.dispose();
    this.edges.material.dispose();
    this.edges = null;
    this.edgeSelect = null;
    this.edgeFace = null;
  }

  /** Carry the face states onto the edge lines, so Hide hides both. */
  syncEdges() {
    if (!this.edgeSelect || !this.selectAttr) return;
    const faceState = this.selectAttr.array;
    const out = this.edgeSelect.array;
    for (let i = 0; i < this.edgeFace.length; i += 1) {
      const f = this.faces[this.edgeFace[i]];
      // Only hidden matters for a line: a red outline over a red face reads
      // as noise, and SimScale keeps its edges one colour too.
      out[i] = f && f.count && faceState[f.start] === SEL.hidden ? SEL.hidden : SEL.none;
    }
    this.edgeSelect.needsUpdate = true;
  }

  /** A PNG of exactly what is on screen. Build spec 12.7. */
  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL("image/png");
  }

  dispose() {
    this.unbindNav?.();
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.clear();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
