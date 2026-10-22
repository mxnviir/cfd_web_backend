// The same pages, rendered once at build time so the HTML is not empty.
//
// Every page shipped `<body><div id="root"></div></body>` and nothing else.
// Measured on the deployed site: 0 characters of body text on all 14 of them.
// Anything that does not run JavaScript — most AI crawlers, link unfurlers
// outside the OpenGraph tags, a reader with scripting off, a slow first paint —
// saw a blank document where the pricing, the terms and the setup guide are.
//
// This module is built for Node (`vite build --ssr`) and used by
// scripts/prerender.mjs. It renders the signed-out view of a page, which is
// exactly what a visitor with no session sees, and injects it into the built
// HTML.
//
// It deliberately does not cover the signed-in screens — dashboard, billing,
// simulations, workbench. Their content only exists after a Firestore read, so
// prerendering them would bake in an empty panel, and they touch browser
// globals during render (window.PAYPAL_CLIENT_ID, for one) which would throw
// here. They are marked noindex instead.
import React from "react";
import { renderToString } from "react-dom/server";
import { Shell } from "./Shell";

import { HomeView } from "./views/HomeView";
import { DocsView } from "./views/DocsView";
import { LapCalcView } from "./views/LapCalcView";
import { SponsorshipView } from "./views/SponsorshipView";
import { MentorshipView } from "./views/MentorshipView";
import { ModellingView } from "./views/ModellingView";
import { PrivacyPolicyView } from "./views/PrivacyPolicyView";
import { TermsView } from "./views/TermsView";
import { RefundPolicyView } from "./views/RefundPolicyView";
import { SponsorshipPolicyView } from "./views/SponsorshipPolicyView";
import { NotFoundView } from "./views/NotFoundView";

/** Built page name -> the two props its entry file passes to the Shell. */
const VIEWS = {
  index: ["home", HomeView],
  docs: ["docs", DocsView],
  "lap-calculator": ["lapcalc", LapCalcView],
  sponsorship: ["sponsorship", SponsorshipView],
  mentorship: ["mentorship", MentorshipView],
  modelling: ["modelling", ModellingView],
  "privacy-policy": ["privacy", PrivacyPolicyView],
  terms: ["terms", TermsView],
  "refund-policy": ["refund", RefundPolicyView],
  "sponsorship-policy": ["spolicy", SponsorshipPolicyView],
  404: ["home", NotFoundView],
};

export const PRERENDERED = Object.keys(VIEWS);

export function render(page) {
  const entry = VIEWS[page];
  if (!entry) throw new Error(`No view registered for page "${page}"`);
  const [view, View] = entry;
  return renderToString(React.createElement(Shell, { view, View }));
}
