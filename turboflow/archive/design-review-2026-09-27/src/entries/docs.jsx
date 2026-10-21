// Entry point for Documentation | TurboFlow.
//
// One page, one view. Everything shared — React, the Firebase client, the shell
// — lands in a chunk the browser caches once and reuses on every other page.
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { Shell } from "../Shell";
import { DocsView } from "../views/DocsView";

createRoot(document.getElementById("root")).render(
  React.createElement(Shell, { view: "docs", View: DocsView }),
);
