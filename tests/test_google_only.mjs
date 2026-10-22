// Google is the only way to make an account (functions/src/users/onUserCreate.ts).
//
// The sign-up hook refuses anything that is not a Google sign-up. Both ways
// round matter: a password or anonymous account must be refused, and a real
// Google sign-up must never be, whichever of the three fields Identity
// Platform happens to fill in.
//
// Run: node tests/test_google_only.mjs   (after `npm run build` in functions/)
import assert from "node:assert/strict";
import { isGoogleSignUp } from "../functions/lib/users/onUserCreate.js";

let n = 0;
const check = (what, event, want) => {
  assert.equal(isGoogleSignUp(event), want, what);
  n++;
};

// Google, reported in each of the places it can appear.
check("google in additionalUserInfo", { additionalUserInfo: { providerId: "google.com" } }, true);
check("google in credential", { credential: { providerId: "google.com" } }, true);
check("google in providerData", { data: { providerData: [{ providerId: "google.com" }] } }, true);
check("google everywhere", {
  additionalUserInfo: { providerId: "google.com" },
  credential: { providerId: "google.com" },
  data: { providerData: [{ providerId: "google.com" }] },
}, true);

// Everything else.
check("password sign-up", {
  additionalUserInfo: { providerId: "password" },
  data: { providerData: [{ providerId: "password" }] },
}, false);
check("anonymous", { data: { providerData: [] } }, false);
check("nothing at all", {}, false);
check("another provider", { additionalUserInfo: { providerId: "github.com" } }, false);
check("a look-alike provider id", { credential: { providerId: "google.com.evil" } }, false);

console.log(`google only: ${n} checks, only a Google sign-up makes an account`);
