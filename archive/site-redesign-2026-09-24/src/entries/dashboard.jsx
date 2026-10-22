// Entry point for the dashboard.
//
// No marketing Shell wrapper any more. The dashboard is the tool's front door
// and shares the Workbench's chrome: its own 72px top bar, its own sidebar,
// and no site header or footer above them.
import React from "react";
import { createRoot } from "react-dom/client";
import DashboardView from "../views/DashboardView";

createRoot(document.getElementById("root")).render(<DashboardView />);
