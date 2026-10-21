// One Admin SDK app for the whole backend.
//
// Every module imports its handles from here rather than calling
// initializeApp() itself, because a second init in the same process throws and
// the failure only shows up on whichever function happens to load second.
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

if (getApps().length === 0) initializeApp();

export const db = getFirestore();
export const auth = getAuth();
export const storage = getStorage();

/**
 * The default Storage bucket.
 *
 * A function, not a constant: getStorage().bucket() resolves the project's
 * bucket name at call time, and calling it at module load runs before the
 * emulator has told the SDK which project it is.
 */
export const bucket = () => storage.bucket();

export { FieldValue, Timestamp } from "firebase-admin/firestore";
