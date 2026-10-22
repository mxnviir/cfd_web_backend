// The Firebase client, and a compat-shaped surface over it.
//
// The old pages loaded five separate compat bundles from gstatic — about
// 450 KB, on every page, before anything rendered. This uses the modular SDK
// from npm, which the bundler can tree-shake down to what is actually called.
//
// The views were written against the compat API (`db.collection('x').doc(y)`,
// `snap.exists`, `firebase.firestore.FieldValue.serverTimestamp()`). Rewriting
// all of that by hand across five thousand lines of generated code is a large
// change with no visible benefit and plenty of room for a silent mistake, so
// instead the small slice of compat those views use is reimplemented here on
// top of the modular calls. The list below is the entire surface — it was
// derived by grepping the app, not guessed, and anything outside it will throw
// rather than quietly return undefined.
import { initializeApp, getApps } from "firebase/app";
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInWithPopup,
  signInWithRedirect, signOut as fbSignOut, signInAnonymously, GoogleAuthProvider,
} from "firebase/auth";
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs,
  setDoc, updateDoc, deleteDoc, onSnapshot, query, where as fsWhere,
  orderBy as fsOrderBy, limit as fsLimit, serverTimestamp, increment,
  writeBatch,
} from "firebase/firestore";
import {
  getFunctions, connectFunctionsEmulator, httpsCallable,
} from "firebase/functions";
import {
  getStorage, connectStorageEmulator, ref as storageRef, uploadBytesResumable,
  getDownloadURL, getBytes,
} from "firebase/storage";

const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

// firebase-config.js is a plain script in public/, so it is not bundled and can
// be swapped between test and production without rebuilding.
const configured = typeof window !== "undefined" && window.FIREBASE_CONFIG;
if (!configured) throw new Error("firebase-config.js must load before the app.");

// Working locally must never touch the live project. The emulator suite runs in
// single-project mode as demo-turboflow, so a local page has to claim that id.
const config = LOCAL
  ? { ...configured, projectId: "demo-turboflow", storageBucket: "demo-turboflow.appspot.com" }
  : configured;

const app = getApps().length ? getApps()[0] : initializeApp(config);

const rawAuth = getAuth(app);
const rawDb = getFirestore(app);
const rawFunctions = getFunctions(app);
const rawStorage = getStorage(app);

if (LOCAL) {
  connectAuthEmulator(rawAuth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(rawDb, "127.0.0.1", 8080);
  connectFunctionsEmulator(rawFunctions, "127.0.0.1", 5001);
  connectStorageEmulator(rawStorage, "127.0.0.1", 9199);
  console.info("firebase: using the local emulators.");
}

// ── camelCase in the app, snake_case in the database ────────────────────────
// Firestore is snake_case: the Workbench, cfd-setup.js, the SimScale worker and
// the new backend all speak it. These pages were written in camelCase, and
// renaming every field across five thousand lines of generated code is exactly
// how a drag number ends up silently mislabelled.
//
// So the conversion happens here, at the one boundary every read and write
// already passes through. Top-level keys only: nested maps like lapCalcDefaults
// and setup are opaque blobs whose inner shape belongs to whoever wrote them.
const TO_SNAKE = { drag_N: "drag_n", lift_N: "lift_n" };
const TO_CAMEL = { drag_n: "drag_N", lift_n: "lift_N" };

export const toSnake = (k) =>
  TO_SNAKE[k] ?? k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
export const toCamel = (k) =>
  TO_CAMEL[k] ?? k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

const mapKeys = (obj, fn) => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const k of Object.keys(obj)) out[fn(k)] = obj[k];
  return out;
};

const fromDb = (d) => mapKeys(d, toCamel);
const toDb = (d) => mapKeys(d, toSnake);

// ── snapshot wrappers ───────────────────────────────────────────────────────
// compat exposes `exists` as a property; modular made it a method. The views
// read it as a property, so it stays one here.
const wrapDoc = (snap) => ({
  id: snap.id,
  exists: snap.exists(),
  data: () => fromDb(snap.data()),
  ref: snap.ref,
});

const wrapQuery = (snap) => ({
  docs: snap.docs.map(wrapDoc),
  size: snap.size,
  empty: snap.empty,
  forEach: (fn) => snap.docs.map(wrapDoc).forEach(fn),
});

// ── document and collection references ──────────────────────────────────────
function docRef(path) {
  const ref = doc(rawDb, path);
  return {
    id: ref.id,
    path,
    _ref: ref,
    get: async () => wrapDoc(await getDoc(ref)),
    set: (data, opts) => setDoc(ref, toDb(data), opts || {}),
    update: (data) => updateDoc(ref, toDb(data)),
    delete: () => deleteDoc(ref),
    onSnapshot: (next, error) => onSnapshot(ref, (s) => next(wrapDoc(s)), error),
    collection: (name) => collectionRef(`${path}/${name}`),
  };
}

function collectionRef(path) {
  // Constraints accumulate as the caller chains, exactly as they did on the
  // compat query object, and are applied when the query is finally run.
  const build = (constraints) => ({
    doc: (id) => docRef(`${path}/${id}`),
    // The field name is a database name, so it converts too — otherwise
    // where('userId', ...) matches nothing at all and the page just looks empty.
    where: (field, op, value) => build([...constraints, fsWhere(toSnake(field), op, value)]),
    orderBy: (field, dir) => build([...constraints, fsOrderBy(toSnake(field), dir || "asc")]),
    limit: (n) => build([...constraints, fsLimit(n)]),
    get: async () => wrapQuery(await getDocs(query(collection(rawDb, path), ...constraints))),
    onSnapshot: (next, error) =>
      onSnapshot(query(collection(rawDb, path), ...constraints),
        (s) => next(wrapQuery(s)), error),
  });
  return build([]);
}

export const db = {
  collection: collectionRef,
  batch: () => {
    const b = writeBatch(rawDb);
    return {
      set: (r, data, opts) => b.set(r._ref ?? r, toDb(data), opts || {}),
      update: (r, data) => b.update(r._ref ?? r, toDb(data)),
      delete: (r) => b.delete(r._ref ?? r),
      commit: () => b.commit(),
    };
  },
};

// ── auth ────────────────────────────────────────────────────────────────────
export const auth = {
  get currentUser() { return rawAuth.currentUser; },
  onAuthStateChanged: (cb) => onAuthStateChanged(rawAuth, cb),
  signInWithPopup: (provider) => signInWithPopup(rawAuth, provider),
  signInWithRedirect: (provider) => signInWithRedirect(rawAuth, provider),
  signInAnonymously: () => signInAnonymously(rawAuth),
  signOut: () => fbSignOut(rawAuth),

  // Google is the only sign-in. Email and password (build spec 3.1) were here
  // and were removed on 24 Sep 2026; see components/AuthModal.jsx.
};

/** True only on localhost, where every Firebase call goes to the emulators. */
export const isLocal = LOCAL;

// ── callables ───────────────────────────────────────────────────────────────
export const functions = {
  httpsCallable: (name) => {
    const fn = httpsCallable(rawFunctions, name);
    return (data) => fn(data);
  },
};

// ── storage ─────────────────────────────────────────────────────────────────
// The Workbench uploads CAD files and reads back the model, the face list and
// the field data a run produces. Uploads are resumable because a 60 MB STEP on
// a school connection is a minutes-long request that must survive a hiccup and
// must report a real percentage rather than a spinner.
export const storage = {
  ref: (path) => storageRef(rawStorage, path),
  upload: (path, blob, meta) =>
    uploadBytesResumable(storageRef(rawStorage, path), blob, meta),
  url: (path) => getDownloadURL(storageRef(rawStorage, path)),
  bytes: (path) => getBytes(storageRef(rawStorage, path)),
  /** A JSON file the worker wrote, such as a saved SimScale event log. */
  getJson: async (path) => {
    const buf = await getBytes(storageRef(rawStorage, path));
    return JSON.parse(new TextDecoder().decode(buf));
  },
};

// ── the `firebase` namespace the views reach for ────────────────────────────
export const firebase = {
  auth: Object.assign(() => auth, { GoogleAuthProvider }),
  firestore: { FieldValue: { serverTimestamp, increment } },
  functions: () => functions,
};

export { rawAuth, rawDb, rawFunctions, rawStorage, GoogleAuthProvider };
