// Signing in with Google, in one place.
//
// The awkward part is not the sign-in, it is the popup. It can be lost before
// it ever opens - Safari and iOS, in-app webviews, popup blockers - and the
// failure arrives as an error code rather than as anything visible, so a
// button that only calls signInWithPopup does nothing at all for those users
// and gives them no reason why. Falling back to a same-tab redirect always
// works, and onAuthStateChanged picks the session up when the tab comes back.
//
// This lived inside Shell.jsx, which is the marketing site's chrome. The
// dashboard renders without the Shell, so its signed-out screen had no way to
// reach any of it: it said "Sign in to see your projects" next to a link to
// the home page, and the only way to sign in was to go there and come back.
import { auth, GoogleAuthProvider } from "./firebase";

/**
 * Returns when the user is signed in, or when they closed the popup.
 *
 * Throws only on a real failure, so a caller can show the message. Closing the
 * popup is not a failure and resolves quietly.
 */
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  try {
    await auth.signInWithPopup(provider);
  } catch (err) {
    const code = (err && err.code) || "";
    if (code === "auth/popup-blocked"
      || code === "auth/operation-not-supported-in-this-environment"
      || code === "auth/web-storage-unsupported") {
      return auth.signInWithRedirect(provider);
    }
    // The person changed their mind. Not something to report at them.
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return undefined;
    throw err;
  }
  return undefined;
}
