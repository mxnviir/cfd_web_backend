// Autoprefixer only. Tailwind used to run here; DESIGN_RULES.md 1.10 bans it.
// Its output was frozen into src/utilities.css for a while and then replaced
// by named classes; only the browser reset survives, in src/reset.css.
export default {
  plugins: {
    autoprefixer: {},
  },
};
