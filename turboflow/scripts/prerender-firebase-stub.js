// Stands in for src/lib/firebase.js during the prerender build only.
//
// src/lib/firebase.js cannot be imported by Node. It reads `location.hostname`
// at module scope to decide whether to point at the emulator suite, and then
// throws outright if `window.FIREBASE_CONFIG` is missing — both correct for a
// browser, both fatal in a build script.
//
// The Shell already imports it dynamically inside an effect, so it never
// reaches the server renderer from there. LapCalcView imports it statically,
// which pulls the whole Firebase client into the module graph of a page that is
// otherwise pure markup.
//
// It is only ever *used* from a save handler and a token fetch, never during
// render, so the renderer needs the names to exist and nothing more. This stub
// is aliased in by scripts/prerender.mjs and is not part of any shipped bundle:
// the browser still loads the real module.
//
// If a view ever calls one of these during render, it will throw here rather
// than silently prerendering a page with a hole in it. That is deliberate.
const unavailable = (name) => () => {
  throw new Error(`firebase.${name} was called while prerendering; it is only available in the browser`);
};

export const db = new Proxy({}, { get: (_, k) => unavailable(String(k)) });
export const auth = new Proxy({}, { get: (_, k) => unavailable(String(k)) });
export const functions = new Proxy({}, { get: (_, k) => unavailable(String(k)) });
export const storage = new Proxy({}, { get: (_, k) => unavailable(String(k)) });
export const firebase = new Proxy({}, { get: (_, k) => unavailable(String(k)) });
export const toSnake = (k) => k;
export const toCamel = (k) => k;
