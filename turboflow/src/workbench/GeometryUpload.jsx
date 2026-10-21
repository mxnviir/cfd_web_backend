// Getting a car into TurboFlow. Build spec 7.1.
//
// This did not exist until 11 Sep 2026. The Geometries "+" navigated to
// /geometry/new, which rendered the empty state and nothing else, so there was
// no way to upload a model through the interface at all: every car in the test
// project had been put there by a script. A Workbench you cannot put a car into
// is not a Workbench.
//
// The order matters and is the storage rules' order, not a preference:
// createUploadIntent mints the geometry id and the one path the rules will
// accept, then the bytes go straight from the browser to that path. The
// document is written by the backend, before the bytes, so there is never a
// moment where the path is unowned.
import React, { useRef, useState } from "react";
import { Modal } from "../dashboard/dialogs";
import { Icon } from "./icons";
import { functions, storage } from "../lib/firebase";
import { prepareCarInBrowser } from "./geometry/buildCar";

/**
 * What the browser's geometry engine can read: STEP. The geometry service
 * also took IGES and STL; the occt-wasm engine that replaced it takes STEP
 * only, and anything else would upload and then fail at import with a worse
 * message than the dialog can give.
 */
const EXTS = ["step", "stp"];
const ACCEPT = EXTS.map((e) => `.${e}`).join(",");

/** The geometry service refuses anything larger, so refuse it here too. */
const MAX_BYTES = 50 * 1024 * 1024;

/** What the dialog opens on, and what it returns to when a file declares nothing. */
const DEFAULT_UNIT = "m";

const UNITS = [
  ["m", "Metres"], ["mm", "Millimetres"], ["cm", "Centimetres"],
  ["in", "Inches"], ["ft", "Feet"],
];

const extOf = (name) => (name.split(".").pop() || "").toLowerCase();
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * A first guess at the unit, from the STEP file's own header.
 *
 * STEP declares its unit, and a car drawn in millimetres that is imported as
 * metres becomes two kilometres long. That exact mistake was made by hand
 * during the first end-to-end run and nothing in the pipeline caught it, so
 * the dialog reads the header and preselects what the file says.
 */
async function unitFromStep(file) {
  if (!["step", "stp"].includes(extOf(file.name))) return null;
  // The unit is declared in the DATA section, which in an OpenCASCADE export
  // is near the *end* of the file: on the test car it sits at line 26934 of
  // 26941. Reading only the header found nothing and the dialog then told a
  // STEP user that "STL files carry no unit". Read both ends.
  const SLICE = 300_000;
  const parts = file.size <= SLICE * 2
    ? [await file.text()]
    : [await file.slice(0, SLICE).text(), await file.slice(file.size - SLICE).text()];
  for (const text of parts) {
    const m = text.match(/SI_UNIT\s*\(\s*\.?(MILLI|CENTI)?\.?\s*,\s*\.METRE\./i);
    if (m) return m[1] ? { MILLI: "mm", CENTI: "cm" }[m[1].toUpperCase()] : "m";
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return "in";
  }
  return null;
}

export default function GeometryUpload({ groupId, onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState(DEFAULT_UNIT);
  const [unitFromFile, setUnitFromFile] = useState(null);
  const [progress, setProgress] = useState(null);
  // The second phase: reading the file and building the model, which used to
  // happen on a container after this dialog closed.
  const [preparing, setPreparing] = useState(null);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);

  const take = async (f) => {
    if (!f) return;
    setError(null);
    if (!EXTS.includes(extOf(f.name))) {
      setError(`TurboFlow reads STEP files. Export your model as STEP and try again.`);
      return;
    }
    if (f.size === 0) {
      setError("That file is empty. Export the model from your CAD tool again and choose the new file.");
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`That file is ${mb(f.size)}. The limit is ${mb(MAX_BYTES)}.`);
      return;
    }
    setFile(f);
    setName(f.name.replace(/\.[^.]+$/, ""));
    const declared = await unitFromStep(f).catch(() => null);
    if (declared) {
      setUnit(declared);
      setUnitFromFile(declared);
      return;
    }
    // Nothing declared, so go back to the default rather than keeping the
    // last file's answer. Dropping a millimetre STEP, changing your mind and
    // dropping an STL used to leave the STL silently set to millimetres,
    // underneath a hint telling the user the unit is the one thing they have
    // to get right. A 210 mm car read as metres is 210 metres long.
    setUnit(DEFAULT_UNIT);
    setUnitFromFile(null);
  };

  const upload = async () => {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const ext = extOf(file.name);
      const intent = await functions.httpsCallable("createUploadIntent")({
        kind: "raw", ext, name: name.trim() || file.name,
        // The group this car belongs to. It was project_id, against a
        // projectId prop nothing passes any more, so every import since the
        // move to groups was created with group_id null: the file uploaded,
        // the service read it, the geometry went ready, and it belonged to no
        // group, so the Workbench never listed it and the viewer stayed on
        // "select a geometry". The server schema takes group_id as optional,
        // which is why nothing complained.
        group_id: groupId, size_bytes: file.size, input_unit: unit,
        // What the geometry service has always been sent. facet_split off,
        // because on a car with curved bodywork it splits every panel into
        // hundreds of faces and every assignment then points at the wrong one.
        import_options: { facet_split: false, sewing: true, improve: true },
      });
      const { geometry_id: geometryId, path } = intent.data;

      await new Promise((resolve, reject) => {
        const task = storage.upload(path, file, { contentType: "application/octet-stream" });
        // A real percentage, from the upload itself. A fake one that runs to
        // 90 and waits is worse than none: it tells you nothing about a file
        // that has actually stalled.
        task.on("state_changed",
          (s) => setProgress(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0),
          reject, resolve);
      });

      setProgress(1);

      // The import itself now runs here, in the browser, on the same engine
      // the tunnel cut uses. The dialog stays open to show it, because "the
      // file uploaded and then nothing happened" was the failure mode that
      // made people upload twice; closing the tab mid-import is still safe -
      // opening the car again picks the import back up.
      setPreparing({ fraction: 0, text: "Preparing the model" });
      await prepareCarInBrowser({
        geometryId, groupId, file, unit,
        onProgress: (p) => setPreparing(p),
      });
      onUploaded?.(geometryId);
      onClose();
    } catch (err) {
      setProgress(null);
      setPreparing(null);
      setError(err?.message || String(err));
    }
  };

  const busy = progress != null;

  return (
    <Modal title="Import geometry" onClose={busy ? () => {} : onClose} width={560}
      footer={(
        <>
          <button type="button" className="wb-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="wb-btn wb-btn-primary" onClick={upload}
            disabled={!file || busy}>
            {busy ? "Uploading" : "Import"}
          </button>
        </>
      )}>
      {!file ? (
        <div
          className={"wb-drop" + (dragging ? " wb-drop-on" : "")}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); take(e.dataTransfer.files?.[0]); }}
        >
          <Icon name="upload" size={22} />
          <p className="wb-drop-main">Drag a CAD file here, or</p>
          <button type="button" className="wb-btn" onClick={() => input.current?.click()}>
            Choose a file
          </button>
          <p className="wb-drop-note">STEP, up to {mb(MAX_BYTES)}.</p>
          <input ref={input} type="file" accept={ACCEPT} hidden
            aria-label="CAD file"
            onChange={(e) => take(e.target.files?.[0])} />
        </div>
      ) : (
        <div className="wb-upform">
          <p className="wb-upfile">
            <Icon name="cube" size={15} /> {file.name} <span className="wb-muted">{mb(file.size)}</span>
            {!busy ? (
              <button type="button" className="wb-linkbtn" onClick={() => { setFile(null); setUnitFromFile(null); setUnit(DEFAULT_UNIT); }}>
                Change
              </button>
            ) : null}
          </p>

          <label className="wb-prow">
            <span className="wb-plabel">Name</span>
            <span className="wb-pcontrol">
              <input className="wb-field" value={name} maxLength={200} disabled={busy}
                onChange={(e) => setName(e.target.value)} />
            </span>
          </label>

          {/* Only when the file did not say.
              A STEP declares its own unit and the dialog reads it, so the row
              was a dropdown showing a fact - and the only thing a person could
              do with it was overrule a fact with a guess. Everything else that
              used to be asked here has moved to the setup panel, where the car
              is on screen while you answer. */}
          {unitFromFile ? (
            <p className="wb-upnote">
              <Icon name="check" size={13} /> The file is in {unitFromFile}.
            </p>
          ) : (
            <label className="wb-prow">
              <span className="wb-plabel">Unit</span>
              <span className="wb-pcontrol">
                <select className="wb-field" value={unit} disabled={busy}
                  onChange={(e) => setUnit(e.target.value)}>
                  {UNITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </span>
              <span className="wb-phint">
                This file does not declare a unit. Check it against the size of
                the real car.
              </span>
            </label>
          )}


          {busy ? (
            <div className="wb-upprog">
              <div className="wb-upbar"><span style={{
                width: `${Math.round((preparing ? preparing.fraction : progress) * 100)}%`,
              }} /></div>
              <span className="wb-muted">
                {preparing
                  ? (preparing.text || `Preparing the model ${Math.round((preparing.fraction ?? 0) * 100)}%`)
                  : progress < 1
                    ? `Uploading ${Math.round(progress * 100)}%`
                    : "Preparing the model"}
              </span>
            </div>
          ) : null}
        </div>
      )}

      {error ? <p className="wb-perror">{error}</p> : null}
    </Modal>
  );
}
