// The 3D viewport: toolbar, picking, box select, context menu, keyboard.
// Build spec 5.6, 6.2, 6.3 and 6.4.
//
// Everything that touches WebGL is in engine.js. This owns the canvas, the
// pointer and key handling, and the overlays that sit on top of it.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Viewer as Engine, NAV_PRESETS } from "./engine";
import ViewBall from "./ViewBall";
import ContextMenu from "./ContextMenu";
import MeasurePanel from "./MeasurePanel";
import { Icon } from "../icons";

const RENDER_LABELS = {
  surfaces: "Surfaces",
  surfacesEdges: "Surfaces with edges",
  wireframe: "Wireframe",
  translucent: "Translucent",
};

/** Number keys to views, per build spec 6.4. */
const VIEW_KEYS = {
  1: "front", 2: "back", 3: "left", 4: "right", 5: "top", 6: "bottom", 0: "iso",
};

function ToolMenu({ tip, icon, items, value, onPick, disabled }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    addEventListener("pointerdown", away);
    return () => removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <span className="wb-toolmenu" ref={box}>
      <button
        type="button" className="wb-icon-btn wb-tip wb-has-menu" data-tip={tip}
        aria-label={tip} aria-expanded={open} disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={icon} size={18} />
      </button>
      {open ? (
        <span className="wb-menu wb-menu-left" role="menu">
          {items.map((it) => (
            <button
              key={it.id} type="button" role="menuitemradio"
              aria-checked={value === it.id}
              className={"wb-menu-item" + (value === it.id ? " wb-menu-item-on" : "")}
              onClick={() => { onPick(it.id); setOpen(false); }}
            >
              {it.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

export default function Viewer({
  glbUrl, faces = [], adjacency = [], scaleToM = 1, selection, onReady,
  banner, onDismissBanner, onMeasurePair, emptyNote, domain, children,
}) {
  const canvas = useRef(null);
  const wrap = useRef(null);
  const [engine, setEngine] = useState(null);
  /*
   * Plain surfaces, not surfaces with edges.
   *
   * "Surfaces with edges" keeps every crease sharper than 30 degrees and, on
   * top of that, the whole boundary of every face. A car exported from CAD is
   * not a few dozen panels: the test car is 2219 trimmed patches, so that is
   * 2219 outlines drawn over the bodywork and the result reads as a mesh of
   * triangles laid over the model rather than as a car. It is still in the
   * render menu, which is where somebody who wants to see the patch layout
   * can turn it on.
   */
  const [renderMode, setRenderMode] = useState("surfaces");
  const [nav, setNav] = useState(() => localStorage.getItem("wb.nav") || "simscale");
  const [boxMode, setBoxMode] = useState(false);
  // The tunnel is shown when there is one. It is a translucent box around the
  // car, not the car-shaped hole the solver actually gets, so there is nothing
  // to hide it from - but T still toggles it, because six sheets of glass
  // between you and a 240 mm model is sometimes in the way.
  const [tunnel, setTunnel] = useState(true);
  const [rect, setRect] = useState(null);
  const [menu, setMenu] = useState(null);
  const [measure, setMeasure] = useState(false);
  const [crosshair, setCrosshair] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const lastMove = useRef(0);
  const drag = useRef(null);

  useEffect(() => {
    if (!canvas.current) return;
    const e = new Engine(canvas.current);
    e.setRenderMode("surfaces");
    setEngine(e);
    return () => e.dispose();
  }, []);

  useEffect(() => { engine?.setNav(nav); }, [engine, nav]);

  /*
   * Follow the theme.
   *
   * The renderer reads its colours once, at construction, so switching to
   * light left the chrome light and the 3D view black: the one part of the
   * screen a theme is most obvious on was the part that ignored it. Watch the
   * attribute the switch writes, and the system preference for the people who
   * never touch the switch.
   */
  // Bumped whenever the theme changes, so anything that reads colours once at
  // construction (the orientation ball) can be told to build itself again.
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    if (!engine) return undefined;
    const apply = () => { engine.applyTheme(); setThemeTick((n) => n + 1); };
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = matchMedia("(prefers-color-scheme: light)");
    media.addEventListener("change", apply);
    apply();
    return () => { observer.disconnect(); media.removeEventListener("change", apply); };
  }, [engine]);

  /**
   * Tell the viewer what is floating over it, whenever it asks.
   *
   * The settings panel and the job drawer are siblings of the canvas, not
   * children, so nothing in the 3D code could see them, and fit to view put
   * the car squarely behind the panel.
   *
   * Measured on demand rather than watched. Watching meant re-framing every
   * time the drawer opened, which threw away whatever the user had orbited to;
   * and measuring the real rectangles beats hard-coding 362px, because the
   * tree is resizable and the drawer is not always open.
   */
  useEffect(() => {
    if (!engine) return undefined;
    engine.measureInset = () => {
      const c = canvas.current?.getBoundingClientRect();
      if (!c || !c.width) return;
      let left = 0;
      let bottom = 0;
      for (const el of document.querySelectorAll(".wb-panel, .wb-jobs-open")) {
        const r = el.getBoundingClientRect();
        if (!r.width || r.right <= c.left || r.left >= c.right) continue;
        // A panel down the left edge eats width; the drawer along the bottom
        // eats height. Nothing floats on the right or the top.
        if (r.left - c.left < c.width / 2) left = Math.max(left, r.right - c.left);
        bottom = Math.max(bottom, c.bottom - r.top);
      }
      // The drawer stops well short of the right-hand edge, so it is only half
      // in the way; charging its full height pushes the car needlessly far off.
      engine.setInset({ left, bottom: Math.min(bottom / 2, c.height / 3) });
    };
    return () => { engine.measureInset = null; };
  }, [engine]);

  useEffect(() => {
    if (!engine) return;
    if (!glbUrl) { engine.clear(); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    engine.load(glbUrl, faces, adjacency, scaleToM)
      .then((mesh) => {
        if (cancelled) return;
        engine.setRenderMode(renderMode);
        onReady?.(engine, mesh);
      })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, glbUrl, faces, adjacency, scaleToM]);

  // Everything the shader shows, from one place, so a stale hover cannot
  // survive a selection change.
  useEffect(() => {
    if (!engine || !selection) return;
    engine.applyStates({
      selected: selection.ids,
      hover: selection.hover,
      hidden: selection.hidden,
      assigned: selection.assigned || [],
      assignedOther: selection.assignedOther || [],
    });
  }, [engine, selection?.ids, selection?.hover, selection?.hidden,
    selection?.assigned, selection?.assignedOther]);

  // The tunnel is six numbers, not geometry the loader fetches, so it is set
  // whenever those numbers change rather than when a model finishes loading.
  useEffect(() => {
    if (!engine) return;
    engine.setTunnel(domain || null);
    engine.setTunnelVisible(tunnel);
  }, [engine, domain, tunnel]);

  const toggleTunnel = useCallback(() => setTunnel((v) => !v), []);

  // ── pointer ───────────────────────────────────────────────────────────────
  const onPointerMove = useCallback((e) => {
    if (!engine) return;
    if (drag.current) {
      setRect({ x0: drag.current.x, y0: drag.current.y, x1: e.clientX, y1: e.clientY });
      return;
    }
    // Throttled to one frame. Build spec 6.2: hover must stay under 16 ms,
    // and running the raycast twice inside one frame cannot help anyone.
    const now = performance.now();
    if (now - lastMove.current < 16) return;
    lastMove.current = now;
    const hit = engine.pick(e);
    selection?.hoverFace(hit?.face ?? null);
  }, [engine, selection]);

  const onPointerDown = useCallback((e) => {
    if (!engine || e.button !== 0) return;
    if (boxMode) {
      drag.current = { x: e.clientX, y: e.clientY };
      canvas.current.setPointerCapture(e.pointerId);
    }
  }, [engine, boxMode]);

  const onPointerUp = useCallback((e) => {
    if (!engine) return;
    if (drag.current) {
      const from = drag.current;
      drag.current = null;
      setRect(null);
      const moved = Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y);
      if (moved > 4) {
        const hits = engine.boxSelect(from.x, from.y, e.clientX, e.clientY);
        if (e.shiftKey || e.ctrlKey || e.metaKey) selection?.add(hits);
        else selection?.set(hits);
        return;
      }
    }
    if (e.button !== 0) return;
    // OrbitControls swallows drags; only treat this as a click if the
    // pointer barely moved, or every orbit would also change the selection.
    if (e.detail > 1) return;
    const hit = engine.pick(e);
    selection?.click(hit?.face ?? null, e);
  }, [engine, selection]);

  const onDoubleClick = useCallback((e) => {
    if (!engine) return;
    const hit = engine.pick(e);
    if (!hit) return;
    engine.setRotationCentre(hit.point);
    // A crosshair for a second, so the user can see where the centre went.
    const r = canvas.current.getBoundingClientRect();
    setCrosshair({ x: e.clientX - r.left, y: e.clientY - r.top });
    setTimeout(() => setCrosshair(null), 1000);
  }, [engine]);

  /*
   * Where the right button went down, so a pan does not end in a menu.
   *
   * Right-drag pans (it is the only pan a laptop trackpad can reach), and
   * every pan ends with a contextmenu event at the point the button came up.
   * Without this the menu opened every single time somebody moved the model,
   * over the part of the car they had just dragged to.
   */
  const rightDown = useRef(null);

  const onContextMenu = useCallback((e) => {
    if (!engine) return;
    e.preventDefault();
    const from = rightDown.current;
    const moved = from
      ? Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y)
      : 0;
    rightDown.current = null;
    if (moved > 5) return;              // that was a pan, not a click
    const behind = engine.pickAll(e, 8);
    setMenu({ at: { x: e.clientX, y: e.clientY }, behind });
  }, [engine]);

  const onPointerDownCapture = useCallback((e) => {
    if (e.button === 2) rightDown.current = { x: e.clientX, y: e.clientY };
  }, []);

  // ── keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!engine) return;
    const isTyping = (t) =>
      t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    const down = (e) => {
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (VIEW_KEYS[e.key]) { engine.setView(VIEW_KEYS[e.key]); return; }
      if (k === "a") { engine.frame(); return; }
      if (k === "b") { setBoxMode((v) => !v); return; }
      if (k === "t") { toggleTunnel(); return; }
      if (k === "h") { selection?.hide(); return; }
      if (k === "m") { setMeasure((v) => !v); return; }
      if (k === "x" || k === "y" || k === "z") engine.setAxisLock(k);
    };
    const up = (e) => {
      const k = e.key.toLowerCase();
      if (k === "x" || k === "y" || k === "z") engine.setAxisLock(null);
    };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => { removeEventListener("keydown", down); removeEventListener("keyup", up); };
  }, [engine, selection, toggleTunnel]);

  const pickNav = (id) => { setNav(id); localStorage.setItem("wb.nav", id); };

  const menuItems = useMemo(() => {
    if (!menu || !engine) return [];
    const has = (selection?.ids.length ?? 0) > 0;
    return [
      { label: "Hide selection", disabled: !has, onClick: () => selection.hide() },
      { label: "Show all", onClick: () => selection.showAll() },
      { label: "Isolate selection", disabled: !has, onClick: () => selection.isolate() },
      { separator: true },
      { label: "Invert selection", onClick: () => selection.invert() },
      { label: "Clear selection", disabled: !has, onClick: () => selection.clear() },
      {
        label: "Select other",
        disabled: menu.behind.length < 2,
        submenu: menu.behind.map((h, i) => ({
          label: `${engine.faces[h.face]?.type || "face"} ${h.face}${i === 0 ? " (front)" : ""}`,
          face: h.face,
          onClick: () => selection.set([h.face]),
        })),
      },
      {
        label: "Expand selection",
        disabled: !has,
        submenu: [
          { label: "Tangent faces", onClick: () => selection.expandTangent() },
          { label: "Same area", onClick: () => selection.expandArea() },
          { label: "Same fillet radius", onClick: () => selection.expandRadius() },
        ],
      },
      { separator: true },
      {
        label: "Fit to selection",
        disabled: !has,
        onClick: () => engine.frame(engine.boundsOf(selection.ids)),
      },
      {
        label: "Set rotation centre here",
        onClick: () => {
          const hit = menu.behind[0];
          if (hit) engine.setRotationCentre(hit.point);
        },
      },
    ];
  }, [menu, engine, selection]);

  return (
    <div className="wb-viewport" ref={wrap}>
      <canvas
        ref={canvas} className="wb-canvas"
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onPointerDownCapture={onPointerDownCapture}
        onPointerLeave={() => selection?.hoverFace(null)}
      />

      <div className="wb-toolbar" role="toolbar" aria-label="Viewer tools">
        <ToolMenu
          tip="Render mode" icon="cube" value={renderMode}
          items={Object.entries(RENDER_LABELS).map(([id, label]) => ({ id, label }))}
          onPick={(m) => { setRenderMode(m); engine?.setRenderMode(m); }}
        />
        <span className="wb-tool-sep" />
        <button type="button" className="wb-icon-btn wb-tip" data-tip="Select solids"
          aria-label="Select solids" aria-pressed={selection?.mode === "solid"}
          onClick={() => selection?.setMode("solid")}>
          <Icon name="cube" size={18} />
        </button>
        <button type="button" className="wb-icon-btn wb-tip" data-tip="Select faces"
          aria-label="Select faces" aria-pressed={selection?.mode === "face"}
          onClick={() => selection?.setMode("face")}>
          <Icon name="cubeFace" size={18} />
        </button>
        <ToolMenu
          tip="Select edges or nodes" icon="cubeNode" value={selection?.mode} disabled
          items={[{ id: "edge", label: "Edges" }, { id: "node", label: "Nodes" }]}
          onPick={(m) => selection?.setMode(m)}
        />
        <button type="button" className="wb-icon-btn wb-tip" data-tip="Select volumes"
          aria-label="Select volumes" disabled>
          <Icon name="layers" size={18} />
        </button>
        <span className="wb-tool-sep" />
        <ToolMenu
          tip="Hide selection" icon="eyeOff" value={null}
          items={[
            { id: "hide", label: "Hide selection" },
            { id: "show", label: "Show all" },
            { id: "isolate", label: "Isolate" },
          ]}
          onPick={(id) => {
            if (id === "hide") selection?.hide();
            if (id === "show") selection?.showAll();
            if (id === "isolate") selection?.isolate();
          }}
        />
        {domain ? (
          <button type="button" className="wb-icon-btn wb-tip"
            data-tip={tunnel ? "Hide the wind tunnel (T)" : "Show the wind tunnel (T)"}
            aria-label={tunnel ? "Hide the wind tunnel" : "Show the wind tunnel"}
            aria-pressed={tunnel}
            onClick={toggleTunnel}>
            <Icon name={tunnel ? "eye" : "eyeOff"} size={18} />
          </button>
        ) : null}
        <button type="button" className="wb-icon-btn wb-tip" data-tip="Box select (B)"
          aria-label="Box select" aria-pressed={boxMode}
          onClick={() => setBoxMode((v) => !v)}>
          <Icon name="boxSelect" size={18} />
        </button>
        <ToolMenu
          tip="Fit and views" icon="fit" value={null}
          items={[
            { id: "fit", label: "Fit to view" },
            { id: "sel", label: "Fit to selection" },
          ]}
          onPick={(id) => {
            if (id === "fit") engine?.frame();
            if (id === "sel" && selection?.ids.length) engine?.frame(engine.boundsOf(selection.ids));
          }}
        />
        <button type="button" className="wb-icon-btn wb-tip" data-tip="Measure (M)"
          aria-label="Measure" aria-pressed={measure} onClick={() => setMeasure((v) => !v)}>
          <Icon name="ruler" size={18} />
        </button>
        <ToolMenu
          tip="Clip and section" icon="clip" value={null} disabled
          items={[{ id: "mesh", label: "Mesh clip" }, { id: "section", label: "Section view" }]}
          onPick={() => {}}
        />
        <span className="wb-tool-sep" />
        <ToolMenu
          tip="Navigation controls" icon="refresh" value={nav}
          items={Object.entries(NAV_PRESETS).map(([id, p]) => ({ id, label: p.label }))}
          onPick={pickNav}
        />
      </div>

      {rect ? (
        <div className="wb-boxsel" style={{
          left: Math.min(rect.x0, rect.x1) - (wrap.current?.getBoundingClientRect().left || 0),
          top: Math.min(rect.y0, rect.y1) - (wrap.current?.getBoundingClientRect().top || 0),
          width: Math.abs(rect.x1 - rect.x0),
          height: Math.abs(rect.y1 - rect.y0),
          // Dashed when dragging right to left, because that direction takes
          // anything the box touches rather than only what is inside it.
          borderStyle: rect.x1 < rect.x0 ? "dashed" : "solid",
        }} />
      ) : null}

      {crosshair ? (
        <span className="wb-crosshair" style={{ left: crosshair.x, top: crosshair.y }} />
      ) : null}

      {menu ? (
        <ContextMenu
          at={menu.at} items={menuItems} onClose={() => setMenu(null)}
          onHoverItem={(s) => selection?.hoverFace(s?.face ?? null)}
        />
      ) : null}

      {measure ? (
        <MeasurePanel
          faces={faces} selected={selection?.ids || []}
          onClose={() => setMeasure(false)} onMeasurePair={onMeasurePair}
        />
      ) : null}

      {banner ? (
        <div className="wb-banner" role="alert">
          <Icon name="warn" size={16} />
          <span>{banner.message}</span>
          {banner.onRetry ? (
            <button type="button" className="wb-banner-action" onClick={banner.onRetry}>Retry</button>
          ) : null}
          <button type="button" className="wb-icon-btn" aria-label="Dismiss"
            onClick={onDismissBanner}><Icon name="x" size={14} /></button>
        </div>
      ) : null}

      {loading ? <div className="wb-viewport-note">Loading the model</div> : null}
      {error ? (
        <div className="wb-viewport-note wb-viewport-bad">
          The model could not be drawn. {error}
        </div>
      ) : null}
      {/* `emptyNote` is for when there *is* a geometry selected and it has
          nothing to draw - a failed import, say. Telling that user to "select
          a geometry" when they have selected one, and it is the selected one
          that broke, is the least useful thing on the screen. */}
      {!glbUrl && !loading ? (
        <div className={"wb-viewport-note" + (emptyNote ? " wb-viewport-bad" : "")}>
          {emptyNote || "Select a geometry, or upload a STEP, IGES or STL file to begin."}
        </div>
      ) : null}

      {children}

      <ViewBall key={themeTick} viewer={engine} onView={(n) => engine?.setView(n)} onHome={() => engine?.frame()} />
    </div>
  );
}
