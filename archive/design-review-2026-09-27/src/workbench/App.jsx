// The Workbench shell: what goes where, and who owns which piece of state.
// Build spec 5.1.
//
// Layout is a CSS grid, not absolute positions: the tree column, the viewport
// and the scene column. The settings panel floats over the viewport rather
// than taking a column, which is what makes it possible for the viewer to
// stay the same width as the user moves between nodes.
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import TopBar from "./TopBar";
import Setup from "./Setup";
import SceneTree from "./SceneTree";
import JobStatus from "./JobStatus";
/*
 * The 3D viewer, loaded on its own.
 *
 * three.js is 163 kB gzipped and it sat in front of everything: the browser
 * fetched and parsed all of it before the Workbench could draw a tree, a top
 * bar or the launch screen, which is 387 kB of the 387 kB that page weighed.
 * Split out, the shell renders on about 220 kB and the engine arrives while
 * the launch bar is still counting - which is time the launch was spending
 * anyway, now spent on something.
 */
const Viewer = React.lazy(() => import("./viewer/Viewer"));
import useSelection from "./viewer/useSelection";
import ShortcutSheet from "./ShortcutSheet";
import SetupPanel from "./panels";
import QueueDialog from "./runs/QueueDialog";
import ErrorBoundary from "./ErrorBoundary";
import GeometryUpload from "./GeometryUpload";
import { cleanDefaults } from "./Setup";
import ResultsPanel, { FieldLegend } from "./runs/ResultsPanel";
import Results from "./Results";
import { clampRunParams, listPrice, levelForFineness } from "../lib/pricing";
import SettingsPanel from "./SettingsPanel";
import { ShareDialog, RenameDialog } from "../dashboard/dialogs";
import HelpButton from "./HelpButton";
import Resizer from "./Resizer";
import { Icon } from "./icons";
import { useRoute } from "./route";
import { useUser, useDoc, useGroupCollection, useSaver, useTabLock } from "./data";
import { db, storage, functions } from "../lib/firebase";
import { currentVersion, rawVersion } from "../lib/geometry";
import "./tokens.css";
import "./workbench.css";
// The shared Modal lives in the dashboard folder and its styles live with it.
// Without this the Workbench's own dialogs (geometry import, queue) render
// unstyled: no scrim, no centring, the card squashed against the tree.
import "../dashboard/dashboard.css";

/**
 * The launch screen, with a bar that means something.
 *
 * Four milestones the Workbench genuinely passes through, not a timer: the
 * session resolving, the group document arriving, its contents arriving, and
 * the model reaching the viewer. Each one is a thing that has either happened
 * or has not, so the bar only moves when something really did.
 *
 * That rule is why there is no fifth step at 90% that waits: the upload
 * progress in the import dialog is a real percentage for the same reason, and
 * a bar that sits at 90 telling you nothing is worse than no bar at all.
 */
const LAUNCH_STEPS = [
  ["Signing you in", (s) => s.user !== undefined],
  ["Opening the group", (s) => s.group],
  ["Reading what is in it", (s) => s.contents],
  ["Loading the model", (s) => s.model],
];

export function LaunchScreen({ state, note }) {
  const done = LAUNCH_STEPS.filter(([, ready]) => ready(state)).length;
  const step = LAUNCH_STEPS.find(([, ready]) => !ready(state));
  const pct = Math.round((done / LAUNCH_STEPS.length) * 100);
  return (
    <div className="wb wb-boot">
      <div className="wb-launch">
        <h1 className="wb-launch-title">TurboFlow</h1>
        <p className="wb-launch-step">{note || (step ? step[0] : "Ready")}</p>
        <div className="wb-launch-bar" role="progressbar"
          aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
          aria-label="Launching the Workbench">
          <span style={{ width: `${pct}%` }} />
        </div>
        <p className="wb-launch-count">{done} of {LAUNCH_STEPS.length}</p>
      </div>
    </div>
  );
}

function GoToDashboard() {
  useEffect(() => {
    const t = setTimeout(() => location.replace("/dashboard"), 300);
    return () => clearTimeout(t);
  }, []);
  return <div className="wb wb-boot">Opening your groups.</div>;
}

function SignedOut({ next }) {
  useEffect(() => {
    const t = setTimeout(() => location.assign(`/dashboard?next=${encodeURIComponent(next)}`), 400);
    return () => clearTimeout(t);
  }, [next]);
  return <div className="wb-boot">Taking you to sign in.</div>;
}

/** The model, face list and body list for whichever geometry is selected. */
function useGeometryFiles(geometry) {
  const [state, setState] = useState({ glbUrl: null, faces: null, adjacency: [], solids: null, error: null });

  useEffect(() => {
    // The car, not whatever version is current. Once a tunnel is built it
    // becomes the current version, and its model is the negative: a block with
    // the car subtracted out of it. Drawing that showed people the inside of a
    // car-shaped hole. The tunnel is drawn separately, from its own numbers.
    const v = rawVersion(geometry)?.version ?? currentVersion(geometry);
    if (!v?.glb_path) { setState({ glbUrl: null, faces: null, adjacency: [], solids: null, error: null }); return; }
    let cancelled = false;
    (async () => {
      try {
        const [glbUrl, facesBytes, solidsBytes] = await Promise.all([
          storage.url(v.glb_path),
          v.faces_path ? storage.bytes(v.faces_path) : null,
          v.solids_path ? storage.bytes(v.solids_path) : null,
        ]);
        if (cancelled) return;
        const parse = (b) => (b ? JSON.parse(new TextDecoder().decode(b)) : null);
        const facesDoc = parse(facesBytes);
        setState({
          glbUrl,
          faces: facesDoc?.faces || null,
          adjacency: facesDoc?.adjacency || [],
          scaleToM: facesDoc?.scale_to_m || 1,
          solids: parse(solidsBytes)?.solids || null,
          error: null,
        });
      } catch (err) {
        if (!cancelled) {
          setState({ glbUrl: null, faces: null, adjacency: [], solids: null, error: err.message || String(err) });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [geometry?.id, geometry?.currentVersion]);

  return state;
}

/** The wind tunnel's six planes, in metres, or null when none has been built. */
function tunnelOf(geometry) {
  const v = currentVersion(geometry);
  return v?.kind === "flow_domain" ? (v.domain ?? null) : null;
}

export default function App() {
  const [route, go] = useRoute();
  const user = useUser();
  const groupId = route.groupId;

  const group = useDoc("groups", groupId);
  const geometries = useGroupCollection("geometries", groupId);
  const simulations = useGroupCollection("simulations", groupId);
  const runs = useGroupCollection("runs", groupId);
  const saver = useSaver();
  const twoTabs = useTabLock(groupId, group.data);

  /*
   * Which of the three arrangements is on screen.
   *
   * Remembered, because it is a working preference rather than a place: a team
   * watching a long run wants Results when they come back, and a team building
   * a car wants Model. Not in the URL for the same reason - it would fill the
   * back button with view switches.
   */
  const [view, setView] = useState(() => {
    try {
      const v = localStorage.getItem("wb.view");
      return v === "results" || v === "split" ? v : "model";
    } catch { return "model"; }
  });
  const pickView = useCallback((v) => {
    setView(v);
    try { localStorage.setItem("wb.view", v); } catch { /* private mode is fine */ }
  }, []);

  const [banner, setBanner] = useState(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [engine, setEngine] = useState(null);
  // The field a finished run is coloured by, for the legend over the viewer.
  const [resultField, setResultField] = useState(null);
  const selection = useSelection(engine);
  // The *id* of the simulation being queued, not the object.
  //
  // Holding the object captured whatever the snapshot happened to say when the
  // dialog opened, and openQueue saves the panel first, so the save and the
  // snapshot that carries it back are still in flight at that moment. The
  // dialog would have quoted the numbers from before the edit it had just
  // committed. Resolved from the live rows below instead.
  const [queueForId, setQueueForId] = useState(null);
  // The *id* of the car the setup dialog is open for, not the object. Same
  // reason as queueForId above: the dialog reads the wheels and the frontal
  // area off the geometry, and holding the object froze whatever the snapshot
  // said when it opened - so a dialog opened while the import was still
  // finishing would offer to build a tunnel around a car it thought had no
  // wheels, for as long as it stayed open.
  // The car the steps are about, in a ref so saveStepSettings does not have to
  // be rebuilt on every render that touches geometry.
  const geometryRef = useRef(null);
  // Whether the open panel is holding edits nobody has committed, so the top
  // bar can stop claiming everything is saved when it is not.
  const [panelDirty, setPanelDirty] = useState(false);
  // The tree's Rename, for a geometry or a simulation. Not the same thing as
  // `renaming` further down, which is the boolean for the group's own
  // rename dialog.
  const [renamingNode, setRenamingNode] = useState(null);
  // Always the current snapshot of the simulation being queued, so the dialog
  // quotes what is actually stored rather than what was stored when it opened.
  const queueFor = queueForId
    ? simulations.rows.find((sim) => sim.id === queueForId) ?? null
    : null;

  // The open panel puts its "may I leave?" here. See SetupPanel.
  const leaveRef = useRef(null);

  /**
   * Move to another node, saving what is open first.
   *
   * A valid draft is saved on the way out, an invalid one keeps the user
   * where they are with the errors still on screen. Every navigation in the
   * Workbench goes through this rather than calling go() directly, because
   * the one that does not is the one that loses somebody's work.
   */
  const navigate = useCallback(async (target) => {
    if (leaveRef.current) {
      const may = await leaveRef.current();
      if (!may) {
        setBanner({ message: "Fix what is marked in red before leaving this panel." });
        return;
      }
    }
    go(target);
  }, [go]);

  /**
   * Open the Queue dialog, saving the open panel first.
   *
   * Queueing is not navigation, so it did not go through navigate() and did
   * not ask the open panel to commit. A user could type 400 iterations, watch
   * the panel's own estimate change to 40 credits, and then queue a run built
   * from the 250 still in the database - charged 25 for a run they had not
   * configured, with the number they typed still on the screen.
   *
   * Same guard as leaving a node: a valid draft is saved on the way, an
   * invalid one keeps them where they are.
   */
  const openQueue = useCallback(async (sim) => {
    if (leaveRef.current) {
      const may = await leaveRef.current();
      if (!may) {
        setBanner({ message: "Fix what is marked in red before queueing this run." });
        return;
      }
    }
    setQueueForId(sim.id);
  }, []);

  // Which geometry the viewport is showing. The route says so directly when a
  // geometry is selected; when a simulation is selected it is that
  // simulation's geometry, because that is what its faces belong to.
  const geometry = useMemo(() => {
    if (route.kind === "geometry") {
      return geometries.rows.find((g) => g.id === route.geometryId) || null;
    }
    if (route.kind === "sim") {
      const sim = simulations.rows.find((s) => s.id === route.simulationId);
      if (sim?.geometryId) return geometries.rows.find((g) => g.id === sim.geometryId) || null;
    }
    return geometries.rows.find((g) => g.status === "ready") || geometries.rows[0] || null;
  }, [route, geometries.rows, simulations.rows]);

  geometryRef.current = geometry;
  const files = useGeometryFiles(geometry);

  const simulation = useMemo(
    () => simulations.rows.find((s) => s.id === route.simulationId) || null,
    [simulations.rows, route.simulationId],
  );

  /**
   * Save a setup through the callable, which validates it.
   *
   * Not a direct Firestore write, even though the rules allow one. The
   * callable is what returns the errors the tree then shows, and a write
   * that skipped it would leave the user looking at a stale green tick until
   * the trigger caught up.
   */
  /**
   * Save the setup. Either half of it, or both.
   *
   * The mesh settings live in their own document field, and this used to send
   * only `spec` - so the Mesh panel had nothing it could write to and was
   * shipped as a note saying there was nothing to set. There is plenty to set;
   * it just had no way home.
   */
  const saveSpec = useCallback(async (spec, meshSpec) => {
    if (!simulation) return;
    const payload = { simulation_id: simulation.id };
    if (spec !== undefined) payload.spec = spec;
    if (meshSpec !== undefined) payload.mesh_spec = meshSpec;
    await saver.save(() => functions.httpsCallable("saveSimulation")(payload));
  }, [simulation, saver]);

  useEffect(() => {
    if (files.error) setBanner({ message: `Could not load the model. ${files.error}` });
  }, [files.error]);

  const rename = (name) =>
    saver.save(() => functions.httpsCallable("updateGroup")({ group_id: groupId, name }));

  /**
   * The distance between two faces, from the geometry service.
   *
   * Not computed here. The shortest distance between two curved surfaces is
   * not the shortest distance between two triangle meshes of them, and on a
   * fillet the two answers differ by more than the number is worth.
   */
  const measurePair = useCallback(async (a, b) => {
    const v = currentVersion(geometry);
    if (!v?.step_path) throw new Error("This geometry has no STEP to measure against.");
    const res = await functions.httpsCallable("measureGeometry")({
      geometry_id: geometry.id, version: geometry.currentVersion, faces: [a, b],
    });
    return res.data;
  }, [geometry]);

  // "+" on the tree opens the import dialog. It used to navigate to
  // /geometry/new, which rendered the empty state and nothing else, so the
  // button appeared to do nothing at all.
  const addGeometry = () => setUploading(true);

  /**
   * Build the wind tunnel and write the setup.
   *
   * The callable returns as soon as the work is dispatched, not when it is
   * done: cutting a car out of a box and re-tessellating it takes minutes, and
   * a browser holding a callable open that long times out and reports a
   * failure for something that is still going perfectly well. The geometry
   * document carries `domain_status`, so the tree shows what is happening and
   * the new simulation appears in it the moment the worker writes it.
   */
  const runSetup = useCallback(async (form, car) => {
    if (!car?.id) return;
    setSetupBusy(true);
    setSetupError(null);
    try {
      const existing = simulations.rows.find((sim) => sim.geometryId === car.id);
      await functions.httpsCallable("prepareDomain")({
        geometry_id: car.id,
        group_id: groupId,
        simulation_id: existing?.id ?? null,
        ...form,
      });
    } catch (err) {
      setSetupError(err?.message || String(err));
    } finally {
      setSetupBusy(false);
    }
  }, [simulations.rows, groupId]);

  /**
   * Step 3 and step 4 edit a simulation that already exists.
   *
   * Only those two: the wheels and the tunnel are decided before there is a
   * simulation to edit, and changing them means cutting the geometry again.
   * Fineness and iterations are just numbers on a document, so they save as
   * they are typed and the next run picks them up.
   */
  const saveStepSettings = useCallback(async ({ fineness, iterations }) => {
    const sim = simulations.rows.find((x) => x.geometryId === geometryRef.current?.id);
    if (!sim) return;
    const payload = { simulation_id: sim.id };
    if (fineness != null) {
      payload.mesh_spec = {
        ...(sim.meshSpec ?? {}),
        sizing: { ...(sim.meshSpec?.sizing ?? {}), fineness },
      };
    }
    if (iterations != null) {
      payload.spec = {
        ...(sim.spec ?? {}),
        simulationControl: {
          ...(sim.spec?.simulationControl ?? {}),
          endTime: { value: iterations, unit: "s" },
          writeControl: { type: "TIME_STEP", writeInterval: iterations },
        },
      };
    }
    await saver.save(() => functions.httpsCallable("saveSimulation")(payload))
      .catch((err) => setBanner({ message: err.message || String(err) }));
  }, [simulations.rows, saver]);

  const saveSetupDefaults = useCallback((form) => {
    if (!user?.uid) return;
    saver.save(() => db.collection("users").doc(user.uid)
      .update({ workbenchDefaults: form }))
      .catch((err) => setBanner({ message: err.message || String(err) }));
  }, [user?.uid, saver]);

  const [uploading, setUploading] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);

  /*
   * Wear the theme the reader chose on every other page.
   *
   * The Shell writes `turboflow-theme` and mirrors it onto <html>, but the
   * Workbench does not render inside the Shell, so it started every visit in
   * whatever the system preferred and ignored the choice. Read once on mount;
   * the switch itself lives in the Shell's sidebar.
   */
  // 1, 2, 3 switch view. Not while typing: a boundary condition called
  // "Inlet 2" should not throw you into Results halfway through naming it.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1") pickView("model");
      if (e.key === "2") pickView("results");
      if (e.key === "3") pickView("split");
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [pickView]);

  useEffect(() => {
    try {
      const mode = localStorage.getItem("turboflow-theme");
      if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
      else delete document.documentElement.dataset.theme;
    } catch (err) { /* private mode: the system preference is a fine default */ }
  }, []);
  const [credits, setCredits] = useState(null);
  // The numbers this user last saved as their own starting point. One listener
  // for both, because they live on the same document and a second one would
  // double the reads for nothing.
  const [setupDefaults, setSetupDefaults] = useState(null);
  useEffect(() => {
    if (!user?.uid) return undefined;
    return db.collection("users").doc(user.uid).onSnapshot((s) => {
      const d = s.exists ? s.data() : {};
      setCredits(d.credits ?? 0);
      setSetupDefaults(cleanDefaults(d.workbenchDefaults));
    }, () => {});
  }, [user?.uid]);

  // How far the launch has got. Each of these is a fact, not a guess.
  const launch = {
    user,
    group: !group.loading && !!group.data,
    contents: !geometries.loading && !simulations.loading,
    // Done when the viewer has something to draw, or when there is honestly
    // nothing to wait for: an empty group, or a car that is still importing
    // and whose progress belongs on the tree rather than behind this screen.
    model: !geometries.loading
      && (!geometry || geometry.status !== "ready" || !!files.glbUrl),
  };
  const launched = launch.user !== undefined && launch.group
    && launch.contents && launch.model;

  if (user === undefined) return <LaunchScreen state={launch} />;
  if (user === null) return <div className="wb"><SignedOut next={location.pathname} /></div>;
  // /workbench with no group is not an error, it is an address with a bit
  // missing - and there is exactly one place to go from it. It used to stop
  // there and say "No group in the address" over a link, which is a dead end
  // dressed up as a message: the user cannot supply a group id by hand, so
  // the only thing they can do is the thing this now does for them.
  if (!groupId) return <GoToDashboard />;
  if (!group.loading && !group.data) {
    return (
      <div className="wb wb-boot">
        That group does not exist, or it is not shared with you.{" "}
        <a href="/dashboard">Go to the dashboard</a>.
      </div>
    );
  }

  // Everything above this is an answer. Below it the Workbench is simply not
  // ready yet, and it used to render anyway: an empty tree, an empty viewport
  // and three skeleton rows, which looks like a group with nothing in it
  // rather than one that has not finished opening.
  if (!launched) return <LaunchScreen state={launch} />;

  return (
    <div className="wb">
      <TopBar
        group={group.data} user={user}
        saveStatus={saver.status} onRetrySave={saver.retry} panelDirty={panelDirty}
        onRename={rename}
        onShare={() => setSharing(true)}
        onCopy={() => saver.save(() =>
          functions.httpsCallable("copyGroup")({ group_id: groupId }))}
        /* The gear renames the group, which is the only group setting the
           Workbench has any business changing. It used to point at the
           dashboard, which is two navigations away from the thing in front of
           you. */
        onSettings={() => setRenaming(true)}
        onHelp={() => setKeysOpen(true)}
        view={view} onView={pickView}
      />

      {twoTabs ? (
        <div className="wb-tabwarn" role="status">
          <Icon name="warn" size={15} />
          This group is open in another tab. Changes here may overwrite changes there.
        </div>
      ) : null}

      <div className="wb-body" data-view={view}>
        <div className="wb-left">
          <Setup
            geometry={geometry}
            geometries={geometries.rows}
            sims={simulations.rows}
            /* What each simulation's newest run did, so the list says which
               have answers and which have not been run. */
            simStatus={Object.fromEntries(simulations.rows.map((sim) => {
              const mine = runs.rows.filter((r) => r.simulationId === sim.id);
              const last = mine[mine.length - 1];
              if (!last) return [sim.id, { dot: "optional", label: "not run" }];
              const dot = last.status === "finished" ? "complete"
                : last.status === "failed" ? "error"
                  : last.status === "cancelled" ? "cancelled" : "running";
              const label = last.summary?.drag != null
                ? `${last.summary.drag.toFixed(3)} N`
                : last.status === "finished" ? "finished"
                  : last.stageText || last.status;
              return [sim.id, { dot, label }];
            }))}
            onPickSim={(id) => navigate({ groupId, kind: "sim", simulationId: id })}
            onNewSim={addGeometry}
            onImport={addGeometry}
            onPickCar={(id) => navigate({ groupId, kind: "geometry", geometryId: id })}
            onCarAction={(what) => {
              if (!geometry) return;
              if (what === "rename") {
                setRenamingNode({ kind: "geometry", id: geometry.id, name: geometry.name || "" });
                return;
              }
              if (what === "download") {
                // The file they uploaded, not the tunnel built round it: that
                // is the one they can open again in their own CAD tool.
                const path = geometry.rawPath || geometry.stepPath;
                if (!path) { setBanner({ message: "This car has no original file to download." }); return; }
                storage.url(path)
                  .then((url) => window.open(url, "_blank", "noopener"))
                  .catch((err) => setBanner({ message: err.message || String(err) }));
              }
            }}
            carVersion={rawVersion(geometry)?.version ?? null}
            tunnelVersion={tunnelOf(geometry) ? currentVersion(geometry) : null}
            simulation={simulation ?? simulations.rows.find((x) => x.geometryId === geometry?.id) ?? null}
            runs={runs.rows.filter((r) => !geometry || r.geometryId === geometry.id)}
            defaults={setupDefaults}
            credits={credits}
            busy={setupBusy}
            error={setupError}
            onBuild={(formValues) => runSetup(formValues, geometry)}
            onSaveSimulation={saveStepSettings}
            onQueue={(run) => {
              const sim = simulation
                ?? simulations.rows.find((x) => x.geometryId === geometry?.id);
              if (run?.id) {
                navigate({ groupId, kind: "sim", simulationId: run.simulationId, node: `runs/run/${run.id}` });
              } else if (sim) {
                openQueue(sim);
              }
            }}
            onSaveDefaults={saveSetupDefaults}
            onHighlight={(faces) => selection.hoverFace?.(null) || selection.set(faces)}
          />
        </div>

        <Resizer />

        {view !== "results" ? (
        <Suspense fallback={<div className="wb-viewport wb-viewport-wait">Loading the 3D viewer</div>}>
        <Viewer
          glbUrl={files.glbUrl} faces={files.faces || []}
          adjacency={files.adjacency || []} scaleToM={files.scaleToM || 1}
          selection={selection} onReady={setEngine}
          onMeasurePair={measurePair}
          /* A geometry that failed to import has nothing to draw, and the
             reason it failed is the only useful thing to say. */
          domain={tunnelOf(geometry)}
          emptyNote={geometry?.status === "failed"
            ? (geometry.error || "This geometry could not be read.")
            : geometry && geometry.status !== "ready"
              ? "Still preparing this geometry."
              : null}
          banner={banner} onDismissBanner={() => setBanner(null)}
        >
          <JobStatus
            runs={runs.rows}
            onView={(r) => navigate({ groupId, kind: "sim", simulationId: r.simulationId, node: `runs/run/${r.id}` })}
            /*
             * Both of these were notes saying the feature "comes with" some
             * other part of the build. Both features are here: cancelRun is
             * deployed and the run panel shows the log. A button that explains
             * why it does nothing is still a button that does nothing.
             */
            onCancel={(r) => saver.save(() =>
              functions.httpsCallable("cancelRun")({ run_id: r.id }))
              .catch((err) => setBanner({ message: err.message }))}
            onLog={(r) => navigate({
              groupId, kind: "sim", simulationId: r.simulationId,
              node: `runs/run/${r.id}`,
            })}
          />
          <HelpButton groupId={groupId} />
          <FieldLegend field={resultField} />
        </Viewer>
        </Suspense>
        ) : null}

        {view === "split" ? (
          <Resizer varName="--wb-results-w" storageKey="wb.resultsWidth"
            min={320} max={900} fromRight className="wb-resizer-results"
            label="Resize the results pane" />
        ) : null}

        {view !== "model" ? (
          <ErrorBoundary className="wb-card rv wb-errorbox"
            title="The results could not be drawn.">
            <Results
              runs={runs.rows.filter((r) => !geometry || r.geometryId === geometry.id)}
              simulation={simulation ?? simulations.rows.find((x) => x.geometryId === geometry?.id) ?? null}
              compact={view === "split"}
              onCancel={(r) => saver.save(() =>
                functions.httpsCallable("cancelRun")({ run_id: r.id }))
                .catch((err) => setBanner({ message: err.message }))}
              onPostProcess={(r) => navigate({
                groupId, kind: "sim", simulationId: r.simulationId,
                node: "post", runId: r.id,
              })}
            />
          </ErrorBoundary>
        ) : null}


        {route.kind === "sim" && simulation && route.node === "post" ? (
          <ErrorBoundary className="wb-card wb-panel wb-errorbox"
            title="The results panel could not be drawn.">
            <SettingsPanel
              title={runs.rows.find((r) => r.id === route.runId)?.name || "Results"}
              value={null} onCommit={() => {}}
              onClose={() => go({
                groupId, kind: "sim", simulationId: simulation.id,
                node: `runs/run/${route.runId}`,
              })}
            >
              <ResultsPanel run={runs.rows.find((r) => r.id === route.runId)}
                engine={engine} onField={setResultField} />
            </SettingsPanel>
          </ErrorBoundary>
        ) : null}

        {route.kind === "sim" && simulation && route.node !== "post" ? (
          <ErrorBoundary className="wb-card wb-panel wb-errorbox"
            title="This panel could not be drawn." key={route.node || "global"}>
          <SetupPanel
            simulation={simulation} node={route.node}
            spec={simulation.spec} meshSpec={simulation.meshSpec}
            geometries={geometries.rows} geometry={geometry}
            version={currentVersion(geometry)} faces={files.faces}
            selection={selection} onSave={saveSpec} leaveRef={leaveRef}
            onDirtyChange={setPanelDirty}
            runs={runs.rows.filter((r) => r.simulationId === simulation.id)}
            onQueue={() => openQueue(simulation)}

            onCancelRun={(run) =>
              saver.save(() => functions.httpsCallable("cancelRun")({ run_id: run.id }))
                .catch((err) => setBanner({ message: err.message }))}
            onPostProcess={(run) =>
              navigate({ groupId, kind: "sim", simulationId: simulation.id,
                node: "post", runId: run.id })}
            /* go(), not navigate(): the panel's X is the discard affordance.
               Routing it through the save guard would make the one control
               that means "throw this away" save instead. */
            onClose={() => go({ groupId, kind: "sim", simulationId: simulation.id })}
            onAssignGeometry={(id) => saver.save(() =>
              db.collection("simulations").doc(simulation.id).update({ geometryId: id }))}
            savedSelections={[]}
          />
          </ErrorBoundary>
        ) : null}

        {view !== "results" ? (
        <SceneTree
          geometry={geometry} faces={files.faces} solids={files.solids}
          selection={selection.ids.map((id) => ({ kind: "face", id }))}
          onSelect={(s) => {
            if (s.kind === "face") selection.set([s.id]);
            if (s.kind === "solid" && engine) {
              selection.set(engine.facesOfSolids(
                (files.faces || []).map((f, i) => (f.solid === s.id ? i : -1)).filter((i) => i >= 0)));
            }
          }}
          savedSelections={[]}
        />
        ) : null}
      </div>

      {sharing ? (
        <ShareDialog
          // group is the loader's {loading, data, error}; the dialog wants
          // the document. Passing the wrapper made the title read Share
          // "undefined".
          group={group.data ?? {}}
          people={Object.entries(group.data?.sharedWith ?? {})
            .map(([uid, permission]) => ({ uid, permission }))}
          onClose={() => setSharing(false)}
          onShare={(email, permission) => saver.save(() =>
            functions.httpsCallable("shareGroup")({ group_id: groupId, email, permission }))}
          onUnshare={(uid) => saver.save(() =>
            functions.httpsCallable("unshareGroup")({ group_id: groupId, uid }))} />
      ) : null}

      {renaming ? (
        <RenameDialog title="Rename group" value={group.data?.name ?? ""}
          onClose={() => setRenaming(false)}
          onSave={async (name) => { await rename(name); setRenaming(false); }} />
      ) : null}


      {uploading ? (
        <GeometryUpload groupId={groupId}
          onClose={() => setUploading(false)}
          onUploaded={(id) => navigate({ ...route, kind: "geometry", geometryId: id })} />
      ) : null}

      {queueFor ? (
        <QueueDialog
          defaultName={`Run ${runs.rows.filter((r) => r.simulationId === queueFor.id).length + 1}`}
          validation={queueFor.validation}
          /*
           * The price, computed here rather than read off a field nobody set.
           *
           * `queueFor.estimatedPrice` was never assigned anywhere: the
           * simulation document has no such field, so the dialog that spends
           * the credits read undefined and rendered "This run costs -
           * credits". Same clampRunParams and listPrice the server charges
           * with, which tests/test_pricing.mjs pins to the server's copy.
           */
          price={(() => {
            try {
              return listPrice(clampRunParams({
                iteration_count: queueFor.spec?.simulationControl?.endTime?.value ?? 1000,
                refine_level: levelForFineness(queueFor.meshSpec?.sizing?.fineness ?? 5),
              }));
            } catch { return null; }
          })()}
          credits={credits}
          endTime={queueFor.spec?.simulationControl?.endTime?.value}
          processors={queueFor.spec?.simulationControl?.numProcessors}
          onClose={() => setQueueForId(null)}
          onQueue={async (name) => {
            const res = await functions.httpsCallable("queueRun")({
              simulation_id: queueFor.id, name,
            });
            setQueueForId(null);
            navigate({
              groupId, kind: "sim", simulationId: queueFor.id,
              node: `runs/run/${res.data.run_id}`,
            });
          }}
        />
      ) : null}

      {renamingNode ? (
        <RenameDialog
          title={renamingNode.kind === "geometry" ? "Rename geometry" : "Rename simulation"}
          value={renamingNode.name}
          onClose={() => setRenamingNode(null)}
          onSave={async (name) => {
            const col = renamingNode.kind === "geometry" ? "geometries" : "simulations";
            await saver.save(() => db.collection(col).doc(renamingNode.id).update({ name }))
              .catch((err) => setBanner({ message: err.message || String(err) }));
            setRenamingNode(null);
          }}
        />
      ) : null}

      {keysOpen ? <ShortcutSheet onClose={() => setKeysOpen(false)} /> : null}
    </div>
  );
}
