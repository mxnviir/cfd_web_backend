// The classic site's entry. One shared module behind every page of the site
// (index, dash, billing, ...), so the browser downloads the app once and
// every other page is HTML plus cached chunks.
//
// The app itself is the original compiled bundle (src/site/app.compiled.js),
// written against script-tag globals: React, ReactDOM, firebase, and the
// auth/db/functions singletons that index.html's inline script used to create.
// It is imported dynamically, after those globals exist, which is the one
// thing ES module hoisting would otherwise get wrong.
import * as React from "react";
import * as ReactDOMClient from "react-dom/client";
import firebase from "firebase/compat/app";
import "firebase/compat/auth";
import "firebase/compat/firestore";
import "firebase/compat/functions";
import "firebase/compat/storage";
import "./site.css";

// The views that have a page of their own. Anything else in a hash is an
// old-style address (/#dash): sent to the page it means.
const PAGES = ["dash", "simulations", "lapcalc", "billing", "docs",
  "sponsorship", "mentorship", "modelling", "terms", "refund", "spolicy"];
const hash = (location.hash || "").slice(1);
if (PAGES.includes(hash)) location.replace("/" + hash);

// firebase-config.js (a plain file, swappable per project) supplies the
// project's config; site-config.js supplies the fallback and the PayPal
// client id. Neither is inline, so the CSP needs no script hashes.
const config = window.FIREBASE_CONFIG || window.SITE_FALLBACK_CONFIG;

// Working locally must never touch the live project. The emulator suite runs
// in single-project mode as demo-turboflow, so a local page has to claim
// that id.
const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
if (LOCAL) {
  config.projectId = "demo-turboflow";
  config.storageBucket = "demo-turboflow.appspot.com";
}

firebase.initializeApp(config);
if (LOCAL) {
  firebase.auth().useEmulator("http://127.0.0.1:9099");
  firebase.firestore().useEmulator("127.0.0.1", 8080);
  firebase.functions().useEmulator("127.0.0.1", 5001);
  firebase.storage().useEmulator("127.0.0.1", 9199);
  console.info("firebase: using the local emulators.");
}

window.React = React;
window.ReactDOM = { createRoot: ReactDOMClient.createRoot };
window.firebase = firebase;
window.PAYPAL_CLIENT_ID = window.SITE_PAYPAL_CLIENT_ID || "";
// What this page should draw, set by data-view on <body> in the page's HTML.
window.__bootView = document.body.dataset.view || "home";

// The singletons the app reads as bare identifiers.
window.auth = firebase.auth();
window.db = firebase.firestore();
window.functions = firebase.functions();

import("../site/app.compiled.js");
