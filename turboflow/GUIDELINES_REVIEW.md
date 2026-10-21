# Web Interface Guidelines review, 27 Sep 2026

Every file in `src/` and the 15 page shells, checked against the Vercel Web
Interface Guidelines (`vercel-labs/web-interface-guidelines`, fetched the same
day). The "Title Case for headings and buttons" rule was skipped: DESIGN_RULES.md
requires sentence case.

Line numbers are as reviewed. Items marked **[fixed]** were changed the same
day, so lines in those files may have moved.

---

## Bugs first

These break something today, not just a guideline.

src/components/InlineRaceCalc.jsx:71 - `Field` declared inside render: every re-render remounted the inputs and wiped typed values **[fixed]**
src/workbench/panels/setup.jsx:210 - "Update" button (newer geometry exists) has no onClick, does nothing
src/workbench/panels/fields.jsx:141 - Vec input coerces each keystroke to Number: cannot type "-" or "0.", so negative and decimal x/y/z values cannot be entered
src/dashboard/dialogs.jsx:31 - initial focus lands on header Close, not the first field (querySelector returns DOM order)
src/dashboard/dialogs.jsx:45 - effect depends on inline `onClose`, so any parent re-render (Firestore snapshot) re-runs it and yanks focus to Close mid-typing
src/workbench/viewer/Viewer.jsx:517 - inline `onView` rebuilds ViewBall's WebGLRenderer, scene and textures on every Viewer render, including hover
src/workbench/panels/setup.jsx:451 - "Reset to default" restores the saved spec, not the defaults (index.jsx:324 passes `spec.numerics`)
src/workbench/SettingsPanel.jsx:184 - Enter is preventDefault'd for every target, so Enter on Close/Delete commits instead of activating the button
src/workbench/panels/fields.jsx:212 - aria-label "Remove face ${f}" is zero-based, visible label is f + 1
src/dashboard/GroupGrid.jsx:65 - empty group.name reads "Actions for undefined", row renders blank
src/workbench/viewer/engine.js:925 - camera tween can't be interrupted; overlapping setView calls stack rAF loops
src/views/SimulationsView.jsx:621 - long unbroken job.error string overflows its box

---

## src/Shell.jsx

src/Shell.jsx:89 - team name input missing autocomplete ("organization")
src/Shell.jsx:93 - "Saving..." → "Saving…" **[fixed]**
src/Shell.jsx:268 - sign-in failure used alert() with raw error, no next step **[fixed: inline error in the sign-in dialog]**
src/Shell.jsx:301 - "Not signed in" error gives no next step
src/Shell.jsx:392 - avatar img missing width/height

## src/components/AuthModal.jsx

src/components/AuthModal.jsx:31 - brand name not wrapped in translate="no"

## src/styles.css

src/styles.css:24 - no color-scheme for either theme **[fixed]**
src/styles.css:346 - select.fancy-select:focus → :focus-visible **[fixed]**
src/styles.css:358 - .animate-spin has no reduced-motion variant **[fixed: slowed under reduced motion]**
src/styles.css:360 - .modal-overlay missing overscroll-behavior: contain **[fixed]**
src/styles.css:368 - .modal-body a has no hover state

## src/chrome.css

src/chrome.css:43 - .site-frame height: 100vh jumps with mobile browser bars **[fixed: 100dvh]**
src/chrome.css:48 - .site-nav animates width, not covered by reduced motion **[fixed: reduced-motion override]**
src/chrome.css:103 - .meter > div animates width **[reduced-motion override added; still width]**

## src/type.css

src/type.css:73 - .t-display, .t-h1, .t-h2 missing text-wrap: balance **[fixed]**

## src/reset.css

src/reset.css:17 - touch-action: manipulation not set anywhere **[fixed]**

## Page shells (all 15 *.html)

*.html:3 - no meta theme-color **[fixed: one per theme]**
*.html - fonts not preloaded (Google Fonts; needs self-hosting to preload a known file)
dashboard.html:47 - no skip link (DashboardApp renders without the Shell)
workbench.html:26 - no skip link (Workbench renders without the Shell)

## src/views/HomeView.jsx

src/views/HomeView.jsx:65 - muted loop keeps playing under prefers-reduced-motion **[fixed: poster frame instead]**
src/views/HomeView.jsx:65 - loop over 5 s with no pause control

## src/views/BillingView.jsx

src/views/BillingView.jsx:153 - "Creating your order." → "Creating your order…" (same 164, 316, 385)
src/views/BillingView.jsx:180 - PayPal error gives no next step
src/views/BillingView.jsx:220 - live region mounted together with its message; keep it mounted, swap text
src/views/BillingView.jsx:255 - h1 → h3, no h2
src/views/BillingView.jsx:271 - '$' + toFixed(2) while cfg.currency can differ → Intl.NumberFormat currency (same 296, 330, 356)
src/views/BillingView.jsx:282 - credits input missing name, autocomplete="off" (same months input 342)

## src/views/LapCalcView.jsx

src/views/LapCalcView.jsx:142 - "Simulation failed." no next step (same 147, 277)
src/views/LapCalcView.jsx:205 - placeholders don't end with "…" (205, 210, 215, 220)
src/views/LapCalcView.jsx:222 - validation error has no role="alert"
src/views/LapCalcView.jsx:242 - "Running..." → "Running…" (same 451); "Saving..." 297
src/views/LapCalcView.jsx:271 - "Saved" not announced
src/views/LapCalcView.jsx:283 - "Save" → "Save defaults"
src/views/LapCalcView.jsx:368 - result region has no aria-live
src/views/LapCalcView.jsx:400 - result.toFixed(4) → Intl.NumberFormat

## src/views/SimulationsView.jsx

src/views/SimulationsView.jsx:50 - "Could not create a token." no next step (same 162, 603)
src/views/SimulationsView.jsx:175 - locale hardcoded 'en-GB' → navigator.languages
src/views/SimulationsView.jsx:186 - toFixed → Intl.NumberFormat (same 586)
src/views/SimulationsView.jsx:243 - CONNECTION_TOKEN and job ID (359) need translate="no"
src/views/SimulationsView.jsx:265 - transition: all **[fixed]**
src/views/SimulationsView.jsx:268 - "Copied!" **[fixed: "Copied"]**, still not announced
src/views/SimulationsView.jsx:385 - "Cancelling..." → "Cancelling…"
src/views/SimulationsView.jsx:592 - "Calculating..." **[fixed]**

## src/views/TermsView.jsx

src/views/TermsView.jsx:6 - straight quotes → curly (same 24)
src/views/TermsView.jsx:30 - "50$" **[fixed: "$50"]**

## src/components/InlineRaceCalc.jsx

src/components/InlineRaceCalc.jsx:64 - "Simulation failed." no next step
src/components/InlineRaceCalc.jsx:66 - "Failed to reach server." no next step **[fixed]**
src/components/InlineRaceCalc.jsx:80 - label not tied to input **[fixed]**
src/components/InlineRaceCalc.jsx:87 - input missing name, autocomplete="off" **[fixed]**
src/components/InlineRaceCalc.jsx:151 - error has no role="alert" **[fixed]**
src/components/InlineRaceCalc.jsx:168 - "Running..." **[fixed]**; result not announced **[fixed: role="status"]**
src/components/InlineRaceCalc.jsx:183 - toFixed(4) → Intl.NumberFormat

## src/components/LapField.jsx

src/components/LapField.jsx:19 - label not tied to input **[fixed: useId]**
src/components/LapField.jsx:32 - input missing autocomplete="off" **[fixed]**

## src/components/TransactionsList.jsx

src/components/TransactionsList.jsx:75 - transition: all **[fixed]**
src/components/TransactionsList.jsx:145 - "Loading..." **[fixed]**
src/components/TransactionsList.jsx:198 - raw t.amount unformatted → Intl.NumberFormat

## src/lib

src/lib/status.js:60 - infinite spin, no reduced-motion fallback **[fixed via .animate-spin]**
src/lib/quantities.js:84 - toFixed(dp) for every quantity → Intl.NumberFormat
src/lib/quantities.js:130 - percent via toFixed(1) + "%" → Intl percent

## src/workbench/App.jsx

src/workbench/App.jsx:63 - launch step copy should end with "…" (same 94, 102, 587)
src/workbench/App.jsx:81 - launch bar animates width, no reduced-motion override
src/workbench/App.jsx:209 - panelDirty tracked but no beforeunload guard anywhere
src/workbench/App.jsx:535 - toFixed(3) N → Intl, non-breaking space before unit
src/workbench/App.jsx:612 - cancelRun immediate, no confirm or undo (same 639, 681)

## src/workbench/TopBar.jsx

src/workbench/TopBar.jsx:20 - save status not announced
src/workbench/TopBar.jsx:22 - "Saving..." **[fixed]**
src/workbench/TopBar.jsx:141 - rename input missing name, autocomplete="off"
src/workbench/TopBar.jsx:179 - navigation via onClick location.assign in a button → <a href> (same 181, 195, 196)

## src/workbench/GeometryUpload.jsx

src/workbench/GeometryUpload.jsx:35 - toFixed(1) MB → Intl, &nbsp;MB
src/workbench/GeometryUpload.jsx:85 - too-large error has no next step
src/workbench/GeometryUpload.jsx:156 - "Uploading" → "Uploading…" (same 228)
src/workbench/GeometryUpload.jsx:191 - name input missing name, autocomplete="off"
src/workbench/GeometryUpload.jsx:224 - progress not announced; bar has no role="progressbar"/aria-value*
src/workbench/GeometryUpload.jsx:235 - error needs role="alert"

## src/workbench/JobStatus.jsx

src/workbench/JobStatus.jsx:105 - live status chip not announced
src/workbench/JobStatus.jsx:133 - Runtime/Cost columns lack tabular-nums
src/workbench/JobStatus.jsx:137 - Cancel run immediate, no confirm

## src/workbench/Results.jsx

src/workbench/Results.jsx:33 - toFixed(3) N → Intl, non-breaking space

## src/workbench/SceneTree.jsx

src/workbench/SceneTree.jsx:48 - toFixed/"m2" → Intl, "m²"
src/workbench/SceneTree.jsx:61 - treeitem: Enter only, no arrows, no roving tabindex, no aria-expanded
src/workbench/SceneTree.jsx:84 - eye button opacity 0 unless row :hover, invisible on keyboard focus
src/workbench/SceneTree.jsx:94 - menu closes on blur 120 ms after Tab into it
src/workbench/SceneTree.jsx:102 - menu items act on onMouseDown only, keyboard can't trigger
src/workbench/SceneTree.jsx:126 - role="tree" holds non-treeitem children; nested items lack role="group"
src/workbench/SceneTree.jsx:156 - ~2200 face rows, no virtualization

## src/workbench/SettingsPanel.jsx

src/workbench/SettingsPanel.jsx:20 - row label is a span, controls unlabelled
src/workbench/SettingsPanel.jsx:58 - NumberField input unlabelled, no name/autocomplete
src/workbench/SettingsPanel.jsx:80 - SelectField select unlabelled
src/workbench/SettingsPanel.jsx:191 - title input missing name, autocomplete="off"

## src/workbench/Setup.jsx

src/workbench/Setup.jsx:63 - toFixed mm/cm² → Intl (same 64, 348, 501)
src/workbench/Setup.jsx:94 - car menu items onMouseDown only; trigger onBlur closes it on Tab: no keyboard path
src/workbench/Setup.jsx:126 - unsaved setup edits, no beforeunload
src/workbench/Setup.jsx:266 - "building" → "building…"; "Setting up" 306 → "Setting up…"
src/workbench/Setup.jsx:339 - wheel face highlight mouse-only
src/workbench/Setup.jsx:486 - "my defaults" → "your defaults"
src/workbench/Setup.jsx:501 - run list drag column lacks tabular-nums

## src/workbench/panels/boundary.jsx

src/workbench/panels/boundary.jsx:216 - Row wraps Vec without group: label nested in label
src/workbench/panels/boundary.jsx:263 - toFixed(1) → Intl
src/workbench/panels/boundary.jsx:318 - flow-rate unit select unlabelled

## src/workbench/panels/fields.jsx

src/workbench/panels/fields.jsx:26 - group Row div has no role="group"/aria-labelledby
src/workbench/panels/fields.jsx:77 - Num input missing name, autocomplete="off" (same Vec 138)
src/workbench/panels/fields.jsx:181 - "Clear all" immediate, no confirm or undo
src/workbench/panels/fields.jsx:190 - face hover highlight mouse-only
src/workbench/panels/fields.jsx:205 - toFixed/toExponential → Intl; "m2" → "m²"

## src/workbench/panels/index.jsx

src/workbench/panels/index.jsx:276 - delete BC/material/result control immediate, no confirm or undo
src/workbench/panels/index.jsx:494 - close (X) discards a dirty draft without warning
src/workbench/panels/index.jsx:496 - save error not announced

## src/workbench/panels/setup.jsx

src/workbench/panels/setup.jsx:121 - toFixed mm/cm² → Intl (same 162, 223, 232)
src/workbench/panels/setup.jsx:153 - face-count column lacks tabular-nums
src/workbench/panels/setup.jsx:252 - Gravity Row wraps Vec without group (same vec() helper 516)
src/workbench/panels/setup.jsx:267 - MaterialDialog body missing overscroll-behavior: contain
src/workbench/panels/setup.jsx:523 - name input missing name, autocomplete="off", spellCheck={false} (same 564)

## src/workbench/panels/useDraft.js

src/workbench/panels/useDraft.js:37 - dirty draft has no beforeunload guard

## src/workbench/runs/Plot.jsx

src/workbench/runs/Plot.jsx:41 - readable() toFixed/toExponential → Intl (same 228; 243 → notation "compact")
src/workbench/runs/Plot.jsx:204 - text alternative is only "${title} chart", no data summary
src/workbench/runs/Plot.jsx:205 - value readout mouse-move only

## src/workbench/runs/QueueDialog.jsx

src/workbench/runs/QueueDialog.jsx:48 - modal body missing overscroll-behavior: contain
src/workbench/runs/QueueDialog.jsx:55 - "Queueing..." **[fixed]**
src/workbench/runs/QueueDialog.jsx:62 - name input missing name, autocomplete="off"
src/workbench/runs/QueueDialog.jsx:96 - request error not announced

## src/workbench/runs/ResultsPanel.jsx

src/workbench/runs/ResultsPanel.jsx:42 - "Opening" → "Opening…"; "Loading the results" 169 → "…" + aria-live
src/workbench/runs/ResultsPanel.jsx:44 - download error not announced
src/workbench/runs/ResultsPanel.jsx:68 - fmt toExponential/toPrecision → Intl
src/workbench/runs/ResultsPanel.jsx:80 - aria-label on role-less div ignored

## src/workbench/runs/RunPanel.jsx

src/workbench/runs/RunPanel.jsx:66 - hardcoded "m min ss s" duration
src/workbench/runs/RunPanel.jsx:215 - toFixed(1)% → Intl percent
src/workbench/runs/RunPanel.jsx:312 - live stage/progress not announced; progressbar 315 unnamed
src/workbench/runs/RunPanel.jsx:329 - run error not announced
src/workbench/runs/RunPanel.jsx:356 - "Reading the log" → "…"
src/workbench/runs/RunPanel.jsx:383 - Cancel cancels a paid run immediately; label → "Cancel run"

## src/workbench/viewer/Viewer.jsx

src/workbench/viewer/Viewer.jsx:36 - menu trigger missing aria-haspopup="menu"
src/workbench/viewer/Viewer.jsx:44 - ToolMenu role="menu": no arrows, no Escape, no focus in/return
src/workbench/viewer/Viewer.jsx:364 - canvas has no accessible name or text alternative
src/workbench/viewer/Viewer.jsx:364 - face pick, box select, double-click rotation centre are pointer-only
src/workbench/viewer/Viewer.jsx:370 - context menu only on right-click (no ContextMenu key / Shift+F10 / button)
src/workbench/viewer/Viewer.jsx:375 - role="toolbar" without roving tabindex
src/workbench/viewer/Viewer.jsx:459 - getBoundingClientRect in render on every pointermove (same 460)
src/workbench/viewer/Viewer.jsx:499 - "Loading the model" → "…" + role="status"
src/workbench/viewer/Viewer.jsx:501 - error not announced, no next step

## src/workbench/viewer/engine.js

src/workbench/viewer/engine.js:145 - OrbitControls keyboard never enabled (listenToKeyEvents)
src/workbench/viewer/engine.js:923 - setView tween ignores prefers-reduced-motion

## src/workbench/viewer/ViewBall.jsx

src/workbench/viewer/ViewBall.jsx:189 - effect deps on unstable onView (see Viewer.jsx:517)
src/workbench/viewer/ViewBall.jsx:197 - drag-orbit and axis click pointer-only; Back/Left/Right/Bottom have no visible control
src/workbench/viewer/ViewBall.jsx:198 - aria-label on canvas without role="img"

## src/workbench/viewer/ContextMenu.jsx

src/workbench/viewer/ContextMenu.jsx:22 - submenu opens on mouseenter only; parent has no click/keydown
src/workbench/viewer/ContextMenu.jsx:32 - face hover preview has no focus equivalent
src/workbench/viewer/ContextMenu.jsx:68 - role="menu": no focus in, no arrows/Home/End, no focus return

## src/workbench/viewer/MeasurePanel.jsx

src/workbench/viewer/MeasurePanel.jsx:20 - toPrecision/toFixed → Intl (same 83, 86)
src/workbench/viewer/MeasurePanel.jsx:21 - normal space before unit → &nbsp;
src/workbench/viewer/MeasurePanel.jsx:24 - "Copied" only in tooltip, not announced; clipboard failure swallowed (31)
src/workbench/viewer/MeasurePanel.jsx:78 - "m2" → "m²"; " x " 86 → " × "; "deg" 100 → "°"
src/workbench/viewer/MeasurePanel.jsx:93 - "Measuring" → "…", no aria-live
src/workbench/viewer/MeasurePanel.jsx:94 - raw error, no next step, not announced

## src/workbench/workbench.css

src/workbench/workbench.css:183 - .wb-tree-head-label ellipsis without nowrap/min-width: 0
src/workbench/workbench.css:1171 - .su-car-name, .su-summary 1228, .su-sim-name 1457, .wb-panel-title 730: truncation without min-width: 0
src/workbench/workbench.css:657 - .wb-scene-eye revealed on :hover only, not :focus-visible
src/workbench/workbench.css:750 - .wb-panel-body, .wb-jobs-body 590, .wb-matlist 898, .wb-lib-list 1108: no overscroll-behavior: contain
src/workbench/workbench.css:1069 - transition: width (same 1103), no reduced-motion override
src/workbench/workbench.css:678 - transition: background
src/workbench/workbench.css:608 - .wb-jobs-table numbers lack tabular-nums
src/workbench/workbench.css:361 - no :hover on .wb-banner-action, .wb-jobs-bar 567, .wb-link 614, .wb-unit 780, .wb-psection-head 824, .wb-linkbtn 1081, .wb-save-bad 60, .wb-errdetail summary 957, .su-more > summary 1261
src/workbench/workbench.css:748 - .wb-sq:hover brightness(0.96) barely visible on dark

## src/workbench/tokens.css

src/workbench/tokens.css:20 - dark .wb/.db never sets color-scheme: dark (light variants do)
src/workbench/tokens.css:20 - no tap-highlight / touch-action on the Workbench root (it doesn't load reset.css)

## src/dashboard/DashboardApp.jsx

src/dashboard/DashboardApp.jsx:65 - "Taking you to sign in." → "…"; "Loading" 194 → "Loading…"
src/dashboard/DashboardApp.jsx:77 - tab, search, sort not in the URL
src/dashboard/DashboardApp.jsx:212 - search input: type="search", name, autocomplete="off", placeholder "…"
src/dashboard/DashboardApp.jsx:228 - navigation via onClick location.assign → <a href> (same 229, 230)
src/dashboard/DashboardApp.jsx:313 - straight quotes around group name → curly
src/dashboard/DashboardApp.jsx:315 - "Deleting..." **[fixed]**

## src/dashboard/GroupGrid.jsx

src/dashboard/GroupGrid.jsx:92 - thumbnail img missing width/height and loading="lazy"

## src/dashboard/dialogs.jsx

src/dashboard/dialogs.jsx:57 - modal body missing overscroll-behavior: contain
src/dashboard/dialogs.jsx:87 - placeholder "aero, 2026" → "…"
src/dashboard/dialogs.jsx:134 - "Creating..." **[fixed]**; "Adding..." 242, "Saving..." 291, "Working..." 322 **[fixed]**
src/dashboard/dialogs.jsx:141 - title input and textarea 151 missing name, autocomplete="off"
src/dashboard/dialogs.jsx:145 - straight quotes → curly (same 227)
src/dashboard/dialogs.jsx:164 - label not tied to a control
src/dashboard/dialogs.jsx:232 - email input missing autocomplete, name, spellCheck={false}, example placeholder
src/dashboard/dialogs.jsx:255 - removing a collaborator immediate; aria-label "Remove" doesn't name the person

## src/dashboard/dashboard.css

src/dashboard/dashboard.css:9 - full-bleed fixed layout, no env(safe-area-inset-*)
src/dashboard/dashboard.css:40 - .db-title and .db-modal-head h2 lack text-wrap: balance
src/dashboard/dashboard.css:166 - .db-modal-body no overscroll-behavior: contain
src/dashboard/dashboard.css:191 - tag remove button no hover

## Passed

src/prerender.jsx, src/entries/*.jsx, src/lib/icons.js, src/lib/signIn.js, src/lib/pages.js,
src/lib/format.js, src/lib/units.js, src/lib/pricing.js, src/lib/materials.js, src/lib/geometry.js,
src/lib/firebase.js, src/buttons.css, src/pages.css, src/views/DashboardView.jsx, src/views/DocsView.jsx,
src/views/MentorshipView.jsx, src/views/ModellingView.jsx, src/views/NotFoundView.jsx,
src/views/PrivacyPolicyView.jsx, src/views/RefundPolicyView.jsx, src/views/SponsorshipPolicyView.jsx,
src/views/SponsorshipView.jsx, src/components/LegalPage.jsx, src/workbench/HelpButton.jsx,
src/workbench/Resizer.jsx, src/workbench/ShortcutSheet.jsx, src/workbench/ErrorBoundary.jsx,
src/workbench/data.js, src/workbench/icons.jsx, src/workbench/route.js, src/workbench/simtree.js,
src/workbench/viewer/useSelection.js
