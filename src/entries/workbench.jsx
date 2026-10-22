// Entry point for the Workbench.
//
// No Shell wrapper: the Workbench owns the whole window, has its own top bar,
// and must not inherit the marketing site's header, footer or theme tokens.
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../workbench/App";

createRoot(document.getElementById("root")).render(<App />);
