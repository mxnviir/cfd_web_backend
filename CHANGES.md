# Changes required before launch

Source: VibeMole scan of turboflow.cloud on 9 September 2026 (StyleMole, SecurityMole, CookieMole,
PolicyMole), checked against the code in this repo and against DESIGN_RULES.md.

Scan totals: 41 passed, 61 to review, 8 blockers. Status: not ready to launch.

---

## 0. The scan graded the wrong build

turboflow.cloud is serving the old single-page app from `cfd_web_frontend`, not this repo.

Evidence:

| Check | turboflow.cloud | turboflow-test.web.app (this repo) |
|---|---|---|
| index.html size | 8792 bytes, identical to `cfd_web_frontend/index.html` | 1754 bytes |
| Last modified | 4 August 2026 | 9 September 2026 |
| Tailwind | CDN script, compiled in the browser | compiled at build time |
| Security headers | none | nosniff, Referrer-Policy, X-Frame-Options |
| Privacy policy page | none | present |

So the domain points at the production Firebase project (turboflow-7b3ca) which still holds the
August deploy. Every PolicyMole "Required" row and most CookieMole failures describe the old site.

**Do this first, then re-scan:**

1. Deploy this repo to production: `firebase deploy --project prod` (alias in `.firebaserc`).
2. Swap `public/firebase-config.js` to the production values before that deploy. The file says which set is which.
3. Change canonical and Open Graph URLs in every `*.html` head from `https://turboflow-test.web.app/` to `https://turboflow.cloud/`. Right now the live site would tell search engines the test host is the real one.
4. Retire `cfd_web_frontend`. Its GitHub Action (`.github/workflows/firebase-hosting-pull-request.yml`) deploys to the production project on every pull request. Delete the workflow or the repo so the old build cannot come back.
5. Re-run the scan against turboflow.cloud. The rest of this file lists what will still be open.

---

## 1. Security (SecurityMole)

### Blockers

**A committed secret.** `supabase/functions/on-new-job/index.ts` line 12 falls back to a hardcoded webhook secret when the env var is missing. The file is tracked in git and the value has been in history since the commit that consolidated the repo.

- Treat the value as leaked. Rotate it wherever it is used.
- Remove the fallback. A missing secret must fail loudly, not fall back to a known string.
- The whole `supabase/` folder is the previous backend. The live app runs on Firebase Functions. Move `supabase/` out of this repo, or delete it. If it stays, rewrite history to drop the secret.
- Same folder: `_shared/util.ts` sets `Access-Control-Allow-Origin: *` on every response. Legacy, but it is what the CORS check flagged.

**Production source maps.** `vite.config.js` sets `sourcemap: true`. The full readable source of every page ships to production. Set it to `false`, or to `"hidden"` and upload the maps to your error tracker only.

**Tessellate container runs as root.** `services/tessellate/Dockerfile` has no `USER` line. `services/simscale-job/Dockerfile` already does it right (uid 10001). Copy that block.

### Needs work

| Scan check | Finding in this repo | Change |
|---|---|---|
| Dockerignore Missing | Neither service folder has a `.dockerignore`. Both Dockerfiles copy named files only, so nothing leaks today, but one careless `COPY . .` later would. | Add `.dockerignore` to both with `__pycache__`, `*.pyc`, `.env*`, `*.json` credentials, `.git`. |
| Docker Copy All Context | Not the case. Both Dockerfiles copy `requirements.txt` and one script. | No change. Mark as reviewed. |
| Multiple Lockfiles | `package-lock.json` at root, in `functions/`, and in `supabase/_migrate/`. | The third one leaves with the `supabase/` folder. Root and functions are two real packages and are fine. |
| Lockfile Missing | Both real packages have a lockfile. | No change. |
| Install Scripts Review | No lifecycle scripts in either `package.json`. Third-party postinstall scripts were not audited. | Run `npm audit` in root and `functions/`. In CI, install with `--ignore-scripts` and add back only what breaks. |
| Env Not Gitignored | `.gitignore` covers `.env`, `.env.*`, `functions/.env*`, admin SDK JSON. Nothing tracked. | No change. Note that `cfd_web_frontend/functions/.env` on disk holds the PayPal secret and a Discord webhook. That folder is not a git repo. Delete the file once the old project is retired, and rotate both values if that folder was ever zipped or shared. |
| GitHub Actions (three checks) | This repo has no workflows. The old repo's workflow uses `${{ secrets.* }}` correctly and does not echo anything. | Nothing to fix here. When a workflow is added, keep secrets in repository secrets and never `echo` env. |
| Api Rate Limit Review | `functions/src/lib/ratelimit.ts` limits five actions per user. Not covered: `startJob`, `createFusionToken`, `revokeFusionToken`, and `exchangeFusionToken`. The last one is a public `onRequest` with no user id to key on. | Add the three callables to `RATE`. For `exchangeFusionToken`, rate limit by client IP and by token hash, and compare hashes in constant time. Also set the Firestore TTL policy on the `rate` collection in the console. The code comment already says this; confirm it was done. |
| Route Guard Review | Every `onCall` goes through `guard()` (auth, rate limit, zod schema). | Verify `startJob` calls `guard` with `humanOnly` where money or account state changes. |
| Public Handler Review | Two public endpoints: `paypalWebhook` (verifies signature with PayPal before acting, rejects with 400, correct) and `exchangeFusionToken`. | Review `exchangeFusionToken` as above. Nothing else is public. |
| Stripe Signature Verification | Not Stripe. PayPal webhook signature verification is implemented in `functions/src/paypal/webhook.ts`. | No change. |
| Email Verification Required | Sign-in is Google only. `onUserCreate` trusts verified providers. | No change. Document it so the check can be marked reviewed. |
| Placeholder Secrets | `config.ts` treats `unset` and `REPLACE_ME` as empty and refuses to call PayPal. Good. The real problem is the hardcoded fallback above. | Covered by the blocker. |
| Supabase Service Role (three checks) | Only inside the legacy `supabase/` folder, server side, read from env. Never in the frontend. | Leaves with the folder. |
| Next Public Private Value | Not a Next app. `public/firebase-config.js` is public by design. The production key sits in a comment in the same file. | Restrict both Firebase web API keys in Google Cloud console to HTTP referrers `turboflow.cloud` and the `*.web.app` hosts. |
| Private Keys / Provider API Keys / DB credentials | None tracked. PayPal, Discord, and the webhook id live in Secret Manager via `defineSecret`. | No change. |
| Response Headers Review | Present: nosniff, Referrer-Policy, X-Frame-Options, HSTS (from Firebase). Missing: Content-Security-Policy and Permissions-Policy. | Add both in `firebase.json` under the `**` source. CSP needs `script-src` for self, `www.gstatic.com`, `www.paypal.com`, `cdn.jsdelivr.net` (Workbench three.js), `frame-src` for PayPal, `connect-src` for Firebase and PayPal hosts, `font-src` for gstatic until fonts are self-hosted. Permissions-Policy: deny camera, microphone, geolocation, payment unless the PayPal flow needs it. |
| Cross Origin Policy Review | Firebase v2 callables accept any origin unless told otherwise. | Pass `cors: ["https://turboflow.cloud"]` in `setGlobalOptions` or per function. |
| Upload Surface Review | Marked not applicable by the scan. `storage.rules` restricts file names, caps size at 200 MB, denies update and list. Residual: any signed-in user can create under `/jobs/{jobId}` for any id. Random UUIDs make guessing impractical. | Accept as is, or add an owner check once the Fusion add-in sends the uid. |
| Dangerous Public Route | Not applicable. | No change. |

---

## 2. Cookies and consent (CookieMole)

Scan: 0 passed, 7 failed, 2 to review. Trackers present, cookie banner absent.

What actually loads on the new build:

- Google Fonts (Inter, JetBrains Mono) on every page. Sends the visitor's IP to Google before any consent.
- PayPal JS SDK on the billing page. Sets PayPal cookies.
- Firebase Auth and Firestore. Essential. Uses IndexedDB, not tracking cookies.
- Workbench: Firebase compat from gstatic and three.js from jsdelivr.

No analytics, no pixels, no tag manager. The privacy policy already says so, and it is true.

**Recommended route: remove the non-essential third parties instead of adding a banner.**

1. Self-host the fonts (this also fixes the font change in section 4). After that the only third-party script outside billing is the Workbench's three.js, which can also be bundled.
2. Load the PayPal SDK only when the user clicks a buy button, not on billing page load. That is a user-initiated action for a service they asked for.
3. Add a "Cookies and local storage" section to the privacy policy listing exactly what is stored and by whom: Firebase Auth session in IndexedDB, PayPal cookies on billing when you pay, nothing else.
4. Confirm `dist/` and `public/` contain no leftover analytics snippets.

With only strictly necessary storage left, a consent banner is not required. The scan may keep flagging "banner absent"; the answer to that is the policy section in step 3, not a banner nobody needs. If you still want a banner, it must be a plain bar that does not cover content, with equal weight accept and decline, per DESIGN_RULES 2.1.

---

## 3. Privacy policy and terms (PolicyMole)

The "Required" table in the scan describes the old site, which had no policy page. This repo has `/privacy-policy`, `/terms`, `/refund-policy`, and `/sponsorship-policy`, all linked from the footer in `Shell.jsx`.

Gaps in `src/views/PrivacyPolicyView.jsx` against the scan's required sections:

| Required section | Current state | Change |
|---|---|---|
| Who we are | Not stated. No legal name, no country. | Add a short "Who we are" block: the operating name, the country you operate from, and the person or entity responsible. |
| Data we collect | Present and specific (sections 2, 3, 5, 7). | Keep. |
| How we use data | Present, spread across sections. | Keep. |
| Legal basis | Missing. | Add one paragraph: contract for account and simulations, legitimate interest for security and abuse limits, consent for anything optional. |
| Your rights | Access and deletion covered. Missing: correct, object, restrict, export, and the right to complain to a supervisory authority. | Extend section 10. |
| Contact | Points to "the channels listed in the Sponsorship section". | Put a direct email on the policy page itself. |
| Cookies and storage | Missing. | Add as described in section 2. |
| Last updated | "September 2026". | Use a full date. |

Also fix: the policy says the SimScale project is public and confidential designs should not be uploaded. That is honest and should stay, but it belongs in the upload flow too, not only in the policy. Show it once on the simulations page before the first upload.

---

## 4. Design (StyleMole and DESIGN_RULES.md)

The scan's 12 flagged signals map to the following code. `design_audit.json` in the parent folder has the counts.

### Tooling

- **Tailwind is in use** (120 distinct utilities across `src/views`, `src/Shell.jsx`, `*.html`; `tailwind.config.js`; `postcss.config.js`). DESIGN_RULES 1.10 bans it. Replace with plain CSS and custom properties in `src/styles.css`. Remove the `@tailwind` directives, the two config files, and the devDependencies.

### Typography

- **Default font stack, single font family.** Inter everywhere, JetBrains Mono for numbers. Inter is banned by DESIGN_RULES 1.4. Pick one text face, self-host it, keep a mono face only for numeric readouts. Remove the Google Fonts links from all 14 HTML heads and the `font-family` in `styles.css`.
- **Oversized hero headline.** `HomeView.jsx`: H1 at `clamp(44px, 6vw, 72px)` weight 900 reading "1-Click CFD.", then an H2 at up to 46px. Two-word heading with a period is banned. Replace with one H1 that states input, action, output. Example shape: "Upload a Fusion 360 car body. Get drag, lift, and predicted race time back from a cloud CFD run." Bring the size down to the 36 to 48px range and weight to 700.
- **Low text contrast.** On the `#141414` ground: `#666666` (about 3.3:1) is used for notes and kicker labels, `#484848` (about 2:1) for "Not included", `#888888` (about 4.6:1) for subtitles and card body. Minimum for body text is 4.5:1. Replace `#666666` and `#484848` with a token around `#9a9a9a` or lighter, and stop using gray for whole paragraphs.
- **Repeated section kicker labels.** Uppercase, 11 to 12px, letter-spaced labels: "Available for", "What's included - free for CFD users", "Not included". Remove the pattern. Use a normal small heading.

### Layout and surfaces

- **Cornered badge and chip spam.** Every home section carries a badge ("Live Now", "Core Service", "Programs", "Free for CFD Users") and the mentorship section adds two audience pills with `borderRadius: 20`. Delete all of them. The information that matters (price, who it is for) goes in the CTA note.
- **Dark mode with recurring accent palette.** Four accents on one page: green `#5de88a`, blue `#4a90d9`, violet, cyan `#5bc4d8`, plus blue gradient buttons. Keep one accent for the primary action and status. Section identity comes from content, not color.
- **Identical card geometry, repeated feature-card grids, saturated accent borders.** The CFD section renders three stacked cards with `borderLeft: 4px solid accent`, radius 12, same padding, same heading size. Replace the three cards with one real result: a screenshot or live embed of a finished run showing drag, lift, and the ranked variants. That is the product.
- **Nested cards inside cards.** Modelling checklist is a card inside a full-height section; `.card-elegant` adds a gradient plus `backdrop-filter: blur(10px)` (glassmorphism, banned). Flatten to one level and remove the blur.
- **Dot grid background.** `.main-grid` in `styles.css` and again in `public/workbench.html`. Remove.
- **Gradients.** 12 `linear-gradient` declarations: `.btn-primary`, `.card-elegant`, number stepper buttons, hero scrim, step connector lines, bottom fade. Buttons become flat. The hero scrim can stay as a flat semi-transparent layer if the video stays.
- **Shadows and hover motion.** 14 `box-shadow` declarations and `.hover-lift` / `translateY(-2px)` on buttons and cards. Keep shadows only on the auth modal and menus. Remove hover lift.
- **Corner radii.** Nine different values (1 to 20px). Pick one small value, 4px at most, as a token. Pills at 20px go away with the badges.
- **Arrow glyph after CTA labels.** Every primary button appends an arrow SVG. Remove.
- **Twin hero buttons.** "Run a Simulation" plus "How It Works". Keep the primary. Make "How it works" a plain text link under the hero paragraph.
- **Numbered 01 02 03 steps** in the mentorship section, with a gradient connector line. Rewrite as a short paragraph or a plain ordered list.
- **Check mark bullet list** in the modelling section. Rewrite as a plain list or a two-column "included / not included" table.
- **Full-height scroll-snap sections.** Every home section is `height: 100vh` with `scrollSnapAlign`. This is the "every section same rhythm" problem and it breaks on short viewports. Let content set the height.
- **Hero.** Left-aligned, which is correct. It has no product evidence, only a looped video behind a dark scrim. Put a real Workbench or result screenshot in the right column and drop the video, or keep the video only if it shows an actual simulation.
- **Number in the hero.** "in 15 seconds" is a measured claim or it is not. Keep it only if you have timed it.

### Copy

- Em dashes: `design_audit.json` counted 9 in copy at the time it ran. My check of `src/` and the HTML entries now finds zero. Re-check `public/workbench.html` and the docs page, which the audit may have counted.
- "No manual setup. No CFD expertise required." and "We have got you." are close to banned patterns. Replace with what the pipeline does: which file types, which mesh settings are automated, what the user still chooses.

### Light mode

There is no light theme. DESIGN_RULES 3.5 requires one designed on its own if both themes ship. If the product stays dark-only, state that decision in DESIGN_RULES.md so the check is closed rather than pending.

---

## 5. Launch gates (from DESIGN_RULES.md section 4)

| Gate | State | Action |
|---|---|---|
| Custom domain on the new build | Not done. Domain serves the August build. | Section 0. |
| Favicon | 32px PNG, 192px PNG, 180px Apple touch present. No SVG icon. | Add `public/icon.svg` and a `<link rel="icon" type="image/svg+xml">` in every head. |
| "Made with AI" tag removed | None found in `src/`, `public/`, or the HTML entries. | Confirm on the deployed page footer after the production deploy. |
| Privacy policy page | Present, needs the additions in section 3. | Section 3. |
| Terms and conditions page | Present at `/terms`. | Re-read once the policy changes so the two agree on data handling and refunds. |
| Meta title, description, OG image | Present, but canonical and OG URLs point at the test host. | Section 0, step 3. |
| No placeholder text, no `#` links, no console errors, no horizontal scroll | Not verified in this pass. | Run through every page at 375px and 1440px after the redesign. |
| Alt text, labels on icon-only controls, visible focus | Not verified. `styles.css` sets `outline: none` on inputs and selects with only a faint glow as the focus cue. | Restore a visible focus outline in the accent color. Audit icon-only buttons in `Shell.jsx`. |
| No Tailwind | Fails. | Section 4. |
| Full DESIGN_RULES pass | Fails. | Section 4. |

---

## 6. Order of work

1. Section 0: production deploy, canonical URLs, retire the old repo and its workflow. Re-scan.
2. Section 1 blockers: rotate and remove the committed secret, drop the `supabase/` folder, turn off source maps, non-root user in tessellate.
3. Section 1 headers and CORS: CSP, Permissions-Policy, callable origins, API key referrer restrictions.
4. Section 3: privacy policy additions. Small, and it closes PolicyMole.
5. Section 2: self-host fonts, lazy-load PayPal, cookies section. Closes CookieMole without a banner.
6. Section 4: remove Tailwind, then the redesign of the home page against DESIGN_RULES.md.
7. Section 5: final gate walk on every page, then re-scan.

---

## Security headers, 12 September 2026

`firebase.json` now sends, on every path:

| Header | Value |
|---|---|
| X-Content-Type-Options | nosniff |
| Referrer-Policy | strict-origin-when-cross-origin |
| X-Frame-Options | SAMEORIGIN |
| Permissions-Policy | camera=(), microphone=(), geolocation=(), payment=(), usb=() |
| Content-Security-Policy-**Report-Only** | see below |

Firebase Hosting adds HSTS itself (`max-age=31556926; includeSubDomains; preload`),
so that one needs no configuration.

The CSP is **Report-Only on purpose**. It was checked against the dashboard and
the Workbench with a real project loaded: Firestore, Auth, Cloud Storage, the
GLB the viewer downloads, Google Fonts and the callables all pass it with no
violations reported.

**Before switching it to enforcing, sign in with Google.** That is the one path
that could not be tested here, because the test session signs in with a minted
custom token and never opens the Google popup. The policy allows
`https://accounts.google.com` and `https://*.firebaseapp.com` as frames for it,
but allowing it and having exercised it are different things, and getting this
wrong locks every user out of the site.

To enforce, rename the header to `Content-Security-Policy`. To watch it in
production first, add a `report-uri` pointing at a collector.

---

## Storage rules have no automated coverage

`tests/test_security.mjs` is 69 checks of **Firestore** rules and none of
Storage. That gap hid a live bug for the whole life of the product: results
were stored at `results/{jobId}/` and owned by a cross-service Firestore lookup
inside the Storage rules, and that lookup does not work — every owner reading
their own results file got 403.

Fixed on 12 September 2026 by putting the uid in the path
(`users/{uid}/results/{jobId}/`), which needs no lookup. Verified against the
deployed test project with a minted token:

| Path | Expected | Got |
|---|---|---|
| own results | allowed (404, object absent) | 404 |
| another user's results | denied | 403 |
| old `results/{jobId}` location | denied | 403 |
| another user's geometry | denied | 403 |

**Still owed:** a Storage rules suite against the emulator, covering at least
those four cases plus the write-once behaviour on geometry uploads. Until it
exists, any change to `storage.rules` has to be checked by hand, and the
control to check against is that an allowed path with a missing object returns
404 while a denied one returns 403.
