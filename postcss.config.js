// Autoprefixer for everything, Tailwind for the classic site's CSS
// (src/entries/site.css is the only file with @tailwind directives, so the
// Workbench's styles pass through unchanged). Tailwind used to be banned
// here for the marketing site's own design system (DESIGN_RULES.md 1.10);
// the legacy SPA that replaced it is built out of utility classes, so its
// CSS is compiled at build time instead of by the Tailwind Play CDN in the
// visitor's browser.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
