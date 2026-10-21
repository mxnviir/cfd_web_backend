// Entry point for Race Time Calculator | TurboFlow.
//
// One page, one view. Everything shared — React, the Firebase client, the shell
// — lands in a chunk the browser caches once and reuses on every other page.
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { Shell } from "../Shell";
import { LapCalcView } from "../views/LapCalcView";

createRoot(document.getElementById("root")).render(
  React.createElement(Shell, { view: "lapcalc", View: LapCalcView }),
);
