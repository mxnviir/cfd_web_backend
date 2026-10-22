// Tailwind for the classic site only. The legacy SPA is written entirely in
// Tailwind utility classes; the Workbench has its own CSS and contains no
// Tailwind at all, so its files are not scanned and nothing of it changes.
//
// The theme is the one the pages used to define inline for the Tailwind Play
// CDN, moved here verbatim so the classes render exactly as they did.
export default {
  content: ["./src/site/app.compiled.js", "./*.html"],
  theme: {
    extend: {
      colors: {
        cyan: { 400: "#5bc4d8", 500: "#3aabca", 600: "#2a8fa8" },
        slate: { 850: "#2e2e2e", 900: "#1e1e1e", 950: "#141414" },
        industrial: { blue: "#4a90d9", glow: "rgba(74,144,217,0.12)", border: "#2e2e2e" },
      },
      fontFamily: { sans: ["Inter", "sans-serif"], mono: ["JetBrains Mono", "monospace"] },
    },
  },
  plugins: [],
};
