// Which Firebase project this build talks to: PRODUCTION (turboflow-7b3ca).
//
// Source of truth for the production web config; scripts/build-prod-site.mjs
// reads this file when it stamps dist-prod/. These values are public by design
// — the live site has always served them (the original single-page app carried
// the apiKey in its own source). What protects the data is firestore.rules and
// storage.rules, not the secrecy of this file.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyC9YRhpugT6eIG0PY7O8EaPcB8re7SCoFA",
  authDomain: "turboflow-7b3ca.firebaseapp.com",
  projectId: "turboflow-7b3ca",
  storageBucket: "turboflow-7b3ca.firebasestorage.app",
  messagingSenderId: "659747979647",
  appId: "1:659747979647:web:e718597ad69cd2b7311a4a",
};
