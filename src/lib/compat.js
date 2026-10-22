// The globals the classic site's compiled bundle reads: `firebase`, `auth`,
// `db`, `functions`, in the shape of Firebase's compat SDK, on the Supabase
// backend in backend.js. The bundle was written against script-tag
// Firebase; this is the whole of the surface it uses (found by grepping
// app.compiled.js), and nothing else is provided.
import { auth, functions, makeDb, FieldValue, GoogleAuthProvider, Timestamp } from "./backend";

// Raw names, as the bundle writes them; reads come back in both spellings.
const db = makeDb({ camel: false });

const authNamespace = Object.assign(() => auth, { GoogleAuthProvider });

export const firebase = {
  auth: authNamespace,
  firestore: Object.assign(() => db, { FieldValue, Timestamp }),
  functions: () => functions,
};

export { auth, db, functions };
