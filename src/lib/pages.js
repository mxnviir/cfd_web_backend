// Where each screen lives now that they are separate pages.
//
// The app used to switch screens with setView('billing'), which changed a state
// variable and nothing else — the URL stayed put, so a screen could not be
// linked to, bookmarked, opened in a new tab, or reloaded. Every one of those
// calls is now a real navigation.
export const PAGES = {
  home: "/",
  dash: "/dashboard",
  simulations: "/simulations",
  billing: "/billing",
  lapcalc: "/lap-calculator",
  docs: "/docs",
  sponsorship: "/sponsorship",
  mentorship: "/mentorship",
  modelling: "/modelling",
  privacy: "/privacy-policy",
  terms: "/terms",
  refund: "/refund-policy",
  spolicy: "/sponsorship-policy",
  workbench: "/workbench",
};

/** The old setView(name), as a navigation. */
export const go = (view) => {
  const href = PAGES[view];
  if (!href) {
    console.warn(`Unknown page: ${view}`);
    return;
  }
  window.location.href = href;
};

/**
 * A `?next=` value, if it really points back into this site.
 *
 * The check this replaces was `next.startsWith("/") && !next.startsWith("//")`,
 * in two places, on the sign-in path. It is wrong, and the way it is wrong is
 * a textbook open redirect:
 *
 *     /\\evil.com      starts with "/" and not with "//"  ->  allowed
 *
 * and every browser normalises a backslash in the authority position to a
 * forward slash, so the address it actually opens is https://evil.com. Proved
 * against Node's URL parser, which follows the same WHATWG rules the browsers
 * do. That is a link on the real turboflow domain, in a sign-in flow, that
 * lands somebody on an attacker's page: exactly the primitive a phishing page
 * wants.
 *
 * Pattern-matching the string is how this keeps happening. Resolve it instead,
 * and ask the parser what origin it came out at. A path that resolves anywhere
 * but here is not a path we will follow.
 */
export function safePath(next, fallback = "/") {
  if (typeof next !== "string" || !next) return fallback;
  try {
    const url = new URL(next, window.location.origin);
    if (url.origin !== window.location.origin) return fallback;
    // Rebuilt from the parsed parts rather than returned as given, so what is
    // navigated to is what was checked.
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

/** Which page is being viewed, for marking the nav link active. */
export function currentView() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  for (const [view, href] of Object.entries(PAGES)) {
    if (href === path) return view;
  }
  return "home";
}
