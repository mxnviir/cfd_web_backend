// Entry point for Billing | TurboFlow.
//
// One page, one view. Everything shared — React, the Firebase client, the shell
// — lands in a chunk the browser caches once and reuses on every other page.
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { Shell } from "../Shell";
import { BillingView } from "../views/BillingView";

createRoot(document.getElementById("root")).render(
  React.createElement(Shell, { view: "billing", View: BillingView }),
);
