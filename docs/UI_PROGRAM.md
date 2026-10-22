# UI programme

Started 23 September 2026. Source of truth: `../DESIGN_RULES.md`. Every item is
done only when it is deployed to turboflow-test and checked there. Production
(turboflow-7b3ca) is not touched.

**Where it stands, 25 Sep 2026 (owner's decisions, in order):**
1. 24 Sep: the site went back to production's original look. 25 Sep: undone,
   at the owner's request: the whole site follows DESIGN_RULES.md again, so the
   23-24 Sep rules version is back (from `archive/site-redesign-2026-09-24/`).
2. 25 Sep: a separate race-engineering look and a new layout for the Workbench
   were tried and rejected ("wrong colours, shapes, fonts"). The Workbench is
   back to its 24 Sep arrangement and look, which uses the site's own tokens
   (`archive/workbench-simscale-layout-2026-09-25/` holds the same files).
3. Kept from 25 Sep: the Garage (`/dashboard`) is the way into the Workbench.
   One row per group with its best drag and Cd, its run count and any run in
   progress; click a row to open that group's Workbench. The site sidebar has
   one "Workbench" link to it instead of separate "Dashboard" and "Workbench"
   links that ended on the same page.
4. Re-audited against the rules, and fixed:
   - Home: five full-window slides, each heading, grey subtitle, paragraph,
     button (1.3, 2.2), with the product video under an 86% veil (3.1), and
     mandatory scroll snapping (1.6). Now the video is shown beside the hero
     text, the product section comes first, and each section is built
     differently and is the height of what is in it.
   - Refund policy said "Last updated: February 2026" over text rewritten in
     September; it says September 2026.
   - The Workbench's scrollbars drew as white bars on dark panels.
   - Every audit passes except 2.4, the four "Last updated" dates, which need
     the owner (see below).
- Still open: "Shared with me" has never listed anything (it filters the
  user's own groups), logged as a separate task. Workbench panels have not
  been read one by one against section 5.

## A. Open defects

From the full-site test and the backend review of 23 September.

- [x] A1 Sharing crashes the page (`PERMISSIONS` undefined in `dashboard/dialogs.jsx`)
- [x] A2 A failed wind-tunnel build shows nothing to the user
- [x] A3 Half-width tunnels fail on a real car that built on 12 September
- [x] A4 `/simulations` shows drag, lift and race time as "Pending" for Workbench runs
- [x] A5 Prices on the site contradict what is charged
- [x] A6 Dashboard top bar is 724 px wide on a phone
- [ ] A7 Race time: `run_lap_calc` is not deployed on test and its source is not in the repo
- [x] A8 `tests/e2e_autosetup.mjs` cannot get a token
- [ ] A9 PayPal is not configured on test (needs sandbox credentials from the owner)
- [x] A10 Small defects: favicon.ico, token panel copy, empty-file message, slow actions with no progress, group card preview and plural, dead "Team settings"/"Usage overview" links, sidebar "Dashboard" goes home, CSV header, "Shared with me" empty state, add-in zip served from the production bucket
- [x] A11 OpenFOAM results: keep the case, convert it for the Workbench viewer, "Download for ParaView"
- [ ] A12 App Check: send tokens from the site (monitoring only)
- [x] A13 Google is the only sign-in (owner's decision, 24 Sep). The test project's password form, its CSS and the client's email/password helpers are deleted; `onUserCreate` refuses any sign-up that is not Google (emulator test: a password sign-up is refused, a Google one gets its 50 credits); `claimSignupBonus` is deleted; the Email/Password provider is off on turboflow-test and `hi@hi.com` is disabled, not deleted. Checked live: the sign-in dialog has one button, Continue with Google.

## B. UI programme

- [x] B1 Remove what does not exist (deployed to turboflow-test on 24 Sep, after the connection came back)
  - Home "Iterative CFD" and the setup guide described automatic parametric sweeps, ranked variants and F3D upload. Rewritten to what the product does.
  - Six simulation-tree rows that only said "Not available in TurboFlow yet", the disabled adjoint switch and the CAD-mode panel.
  - The Help popover's "share with support" switch, which nothing handled.
  - src/components/chrome.jsx (20 components, none mounted), src/lib/utm.js, src/views/ActiveJobView.jsx; chrome.css 949 -> 104 lines. The skip link is mounted.
  - Instagram hand-off for results replaced by the ParaView download (A11).
- [x] B2 Every mechanically checkable rule in DESIGN_RULES.md is an automated check in `scripts/design-audit.mjs`, run by `tests/run-all.sh`
  Baseline on 24 Sep, 8 rules failing:
  - 1.10 utilities.css exists; 593 utility classes in markup
  - 1.3 numbered 01 02 03 steps: 9
  - 2.2 uppercase labels: 38
  - 2.4 hardcoded "Last updated" dates: 4 (the legal pages; need the owner to confirm they are current)
  - 3.5 colour literals in components: 54
  - 1.4 five font weights (400, 500, 600, 650, 700); 13 of 22 headings in title case
  Now (24 Sep, deployed to turboflow-test): 1 rule failing, the four "Last updated" dates, which wait on the owner.
- [x] B3 No utility-class framework: `src/utilities.css` deleted, every utility class replaced by a named class on tokens
  - The browser reset it carried is `src/reset.css`. Page layout is `src/pages.css`: `.page`, `.clause`, `.facts`, `.flow`, `.actions`, billing.
  - The four policy pages share `components/LegalPage.jsx`. Home, docs, 404, billing, mentorship, modelling and sponsorship were rewritten in JSX on the type scale; the sidebar in `Shell.jsx` is one list of real links, styled in `chrome.css`.
  - Fixed on the way: the credit "minus" stepper was blank, the balance label sat above the theme picker instead of the balance, the refund page pointed at an "Active Jobs" section that no longer exists, the sign-in dialog had no label, no Escape and unlinked terms, the test sign-in form had the test password typed into the public bundle, the team-name dialog reported errors with alert().
  - Status badges, the viewer and the view ball read colours from tokens (no hex left in components). Uppercase labels and the 500/650 weights are gone.
- [ ] B4 One design system: the Workbench and dashboard use the site's tokens, type scale and buttons
  - Done so far: three weights site-wide, no uppercase labels in the Workbench or dashboard, one 4 px radius (the on/off switch keeps its pill), the Workbench buttons use the site's secondary border, disabled look and hover fill, and `db-btn-dark` (a copy of the primary button) is gone.
  - Found on the way: every primary button on the site was white on #4a90d9 in the dark theme, 3.34:1, under AA. The contrast audit only read the Workbench's stylesheets. It now reads the site's too, and the site fills buttons with `--accent-fill` (#2f6cb0, 5.39:1), the value the Workbench already used. The skip link, avatar, theme picker and stepper hover were the other failures.
  - Found on the way: on `/simulations` the faces, drag and lift figures were white text on a pale wash, invisible on the light theme; and lift was shown as `Math.abs`, so downforce read as lift. Both fixed.
  - Kept on purpose: the Workbench's smaller type scale (13 px body). It is a dense tool, and the site's 16 px body would cost it a third of its rows.
- [ ] B5 Page by page against section 5 of the rules: first-screen answers, hero, copy, loading and error states, focus, mobile, both themes
  Done and checked live on turboflow-test (24 Sep):
  - Home: the hero said the solve "runs on our machines"; it runs on SimScale. It now says what the solve is (steady RANS, k-omega SST, on SimScale), which is also the first-screen answer to "why trust the result".
  - /simulations: a skeleton of three run cards while loading instead of a lone spinner (built, not yet seen on screen: the list loaded before the first check); a failed cancel is a line on the run instead of alert() (not triggered live); run id and date were set in 1.9:1 and 3:1 greys.
  - Race time calculator: on a phone the form was 160 px wide and its fields ran over each other, with scrolling turned off. It stacks and scrolls below 900 px.
  - Dashboard on a phone: the sidebar was hidden, so "Shared with me" and "Recent" could not be reached. They are tabs above the groups.
  - Share dialog: adding an address with no account cleared the field and showed nothing. It says nothing was shared and why; the Add button says "Adding..." while it waits (about 8 s on a cold start).
  - Every site page checked at 375 px: no sideways scroll.
  Left:
  - LapCalcView, SimulationsView and TransactionsList still carry 52 hardcoded font sizes (type audit budget) and most of their layout in inline styles.
  - The home hero's video sits under an 86% veil; rule 3.1 wants real product evidence visible in the hero. Needs a decision on what to show.
  - The Workbench panels have not been read page by page against section 5 yet.
