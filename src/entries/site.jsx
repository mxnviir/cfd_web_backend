// The classic site's entry. One shared module behind every page of the site
// (index, dash, billing, ...), so the browser downloads the app once and
// every other page is HTML plus cached chunks.
//
// The app itself is the original compiled bundle (src/site/app.compiled.js),
// written against script-tag globals: React, ReactDOM, firebase, and the
// auth/db/functions singletons that index.html's inline script used to create.
// Those globals are now the Supabase backend in Firebase's shape (lib/compat).
// It is imported dynamically, after those globals exist, which is the one
// thing ES module hoisting would otherwise get wrong.
import * as React from "react";
import * as ReactDOMClient from "react-dom/client";
import { firebase, auth, db, functions } from "../lib/compat";
import "./site.css";

// The views that have a page of their own. Anything else in a hash is an
// old-style address (/#dash): sent to the page it means.
const PAGES = ["dash", "simulations", "lapcalc", "billing", "docs",
  "sponsorship", "mentorship", "modelling", "terms", "refund", "spolicy"];
const hash = (location.hash || "").slice(1);
if (PAGES.includes(hash)) location.replace("/" + hash);

// The backend comes from supabase-config.js (a plain file, swappable per
// project) and is reached through lib/compat, which gives the bundle the
// Firebase-shaped globals it was written against. site-config.js supplies
// the PayPal client id.
window.React = React;
window.ReactDOM = { createRoot: ReactDOMClient.createRoot };
window.firebase = firebase;
window.PAYPAL_CLIENT_ID = window.SITE_PAYPAL_CLIENT_ID || "";
// What this page should draw, set by data-view on <body> in the page's HTML.
window.__bootView = document.body.dataset.view || "home";

// The singletons the app reads as bare identifiers.
window.auth = auth;
window.db = db;
window.functions = functions;

import("../site/app.compiled.js");
