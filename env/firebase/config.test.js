// Which Firebase project this build talks to: the TEST project (turboflow-test).
//
// Source of truth for the web config. scripts/sync-env.mjs copies the file for
// the project being built to turboflow/public/firebase-config.js, which is what
// the page loads and the add-in build reads. That copy is generated — edit this
// file (or config.prod.js), never the copy.
//
// These values are public by design — they identify the project, they do not
// authorise anything. What protects the data is firestore.rules and
// storage.rules, not the secrecy of this file.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyAa2xUoMWrVjNGYEmrRfzBy8CKQRC8NhK8",
  authDomain: "turboflow-test.firebaseapp.com",
  projectId: "turboflow-test",
  storageBucket: "turboflow-test.firebasestorage.app",
  messagingSenderId: "653114694502",
  appId: "1:653114694502:web:eda3415165a0335f7d86a7",
};
