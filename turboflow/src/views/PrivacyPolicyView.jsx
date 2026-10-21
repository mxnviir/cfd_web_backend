// Privacy policy.
//
// Written from what the code actually does, not from a template: the fields
// onUserCreate writes, the paths createUploadIntent mints, what the SimScale
// worker sends onward, and what capturePayPalOrder records. If any of that
// changes, this page is wrong and has to change with it.
//
// Section 4 is the one worth reading twice. Geometry is uploaded to a SimScale
// project whose visibility is set on the SimScale account, and the account
// TurboFlow runs on can only use public projects. That has to be disclosed
// rather than discovered.
//
// This is a factual description of the system, not legal advice. Have it
// reviewed before launch.
import React from "react";
import { LegalPage } from "../components/LegalPage";

const SECTIONS = [
  {
    t: "1. Who this covers",
    b: "This policy describes what TurboFlow collects when you use the service, why, and who else sees it. It applies to the website, the Workbench, and the Fusion 360 add-in. If you have not signed in and have not uploaded anything, we hold nothing about you.",
  },
  {
    t: "2. What we collect when you sign in",
    b: "Signing in uses Google. Google tells us your email address, your display name and your profile photo URL, and gives us an account identifier. We store those, plus the date you joined and the date you were last seen. We never receive your Google password. You can add a team name, a region and a contact email; those are optional and you can change or clear them at any time.",
  },
  {
    t: "3. What we collect when you run a simulation",
    b: "The geometry file you upload, the entity_labels.csv that describes its faces, and the settings for the run: wind speed, iteration count, refinement level, and the full setup you configured. We keep the results the solver produces, including drag and lift, the convergence history, and the surface fields the Workbench draws. We also keep a record of every credit charged, refunded or reversed, and what it was for.",
  },
  {
    t: "4. Your geometry is sent to SimScale, in a public project",
    b: "Simulations are run on SimScale, a third-party service. Your geometry file and your run settings are uploaded to a SimScale project belonging to TurboFlow, and the results come back from there. That project's visibility is a setting on the SimScale account, and the account TurboFlow currently runs on can only use projects marked public. A public SimScale project is visible to other SimScale users through their public library. If your car design is confidential, do not upload it until you have confirmed with us that this has changed.",
  },
  {
    t: "5. Payments",
    b: "Payments are handled by PayPal. Your card details never reach us and are never stored by us. What we keep is the PayPal order identifier, the capture identifier, the amount, and the credits granted, so that a purchase can be reconciled and audited later. A pending order that is never completed is deleted automatically after three hours.",
  },
  {
    t: "6. Where it is stored",
    b: "In Google Cloud, through Firebase: account records and job history in Firestore, uploaded files and results in Cloud Storage, sign-in handled by Firebase Authentication. Files you upload are stored under a path that is scoped to your account, and the security rules refuse a request for another account's path.",
  },
  {
    t: "7. Connection tokens",
    b: "The Fusion 360 add-in uses a connection token you create on the Simulations page. We store only a cryptographic hash of it, never the token itself, which is why a lost token is replaced rather than recovered. A session created from one may submit jobs and nothing else: it cannot buy credits or change your account. Revoke a token at any time and it stops working immediately.",
  },
  {
    t: "8. Who else sees your data",
    b: "SimScale, to run the simulation, as described above. PayPal, to take payment. Google Cloud, as the infrastructure it all runs on. A notification containing the job identifier, team name and file name is posted to an internal Discord channel when a run starts. We do not sell your data, and we do not use advertising or analytics trackers.",
  },
  {
    t: "9. How long we keep it",
    b: "Account records and job history are kept while your account exists. Uploaded geometry is kept so that a simulation can be run against it again without re-uploading. Results are kept so you can return to them. Ask us and we will delete your account and everything attached to it.",
  },
  {
    t: "10. Your choices",
    b: "You can edit or clear your profile fields yourself. You can revoke any connection token. You can ask us for a copy of what we hold about you, or to delete it. Deleting your account removes your profile, your job history and your uploaded files; a simulation already running in SimScale cannot always be recalled.",
  },
  {
    t: "11. Children",
    b: "TurboFlow is built for STEM Racing and F1 in Schools teams, so some users are under 18. We collect no more from a younger user than from anyone else, and nothing beyond what is listed above. If you are under 13, ask a teacher or guardian to set the account up.",
  },
  {
    t: "12. Changes and contact",
    b: "If this policy changes in a way that affects what we collect or who sees it, we will say so on this page and update the date above. For any question about your data, or to request a copy or a deletion, contact us through the channels listed in the Sponsorship section.",
  },
];

const PrivacyPolicyView = () => (
  <LegalPage title="Privacy policy" updated="September 2026" clauses={SECTIONS} />
);

export { PrivacyPolicyView };
