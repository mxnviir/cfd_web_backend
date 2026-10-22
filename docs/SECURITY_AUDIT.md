# TurboFlow security audit

14 September 2026. Read against the code in this repo and the live configuration of
`turboflow-test`. Everything below was checked in the source or against the deployed
project; nothing here is a guess. Where I could not verify something I say so.

Covered: `firestore.rules`, `storage.rules`, all 20 callables, the 4 HTTP functions,
the 3 Firestore/Auth triggers, the geometry service (`services/tessellate`), the
SimScale worker (`services/simscale-job`), the browser bundle, the hosting headers,
and the IAM of the service accounts everything runs as.

---

## Status, 14 September 2026

Ten of these are fixed, deployed to `turboflow-test`, and covered by tests that
were made to fail first. The rest need a decision or console work and are listed
under "Not fixed" below.

| # | Finding | State |
|---|---|---|
| 1 | Priced from two fields, solver sent the whole document | **Fixed** — `simulations/clamp.ts`, 37 unit checks + a live emulator test |
| 2 | One service account owns the project | **Partly** — the container is no longer root; the IAM split is still open |
| 3 | Unlimited Storage writes, no quota | Not fixed — needs a cap you choose |
| 4 | `exchangeFusionToken` public and unthrottled | **Fixed** — limited by IP; the sham `timingSafeEqual` removed |
| 5 | No App Check | **Partly** (23 Sep) — reCAPTCHA Enterprise key created and registered with App Check on turboflow-test; nothing enforced, and the site does not send tokens yet. Switching the site on needs a decision on the badge, the privacy policy and page weight; enforcement must exempt the Fusion add-in, which cannot produce tokens |
| 6 | A connection token can delete the account | **Fixed** — `humanOnly` on the destructive callables, `human()` in the delete rules |
| 7 | Naming a group does not require being in it | **Fixed** — rules and `createUploadIntent` |
| 8 | A simulation can name another user's geometry | **Fixed** — `mustReachGeometry` in `createSimulation` |
| 9 | A collaborator can drain the owner's credits | Not fixed — a policy question |
| 10 | Sharing gives no access to the files | Not fixed — needs a signed-URL callable |
| 11 | Password sign-ups never get the 50 credits | **Gone** — Google is the only sign-in since 24 Sep 2026; `claimSignupBonus` removed |
| 12 | CSP is Report-Only and inert | Not fixed — add the PayPal origin, then enforce |
| 13 | Rate limiting silently optional | **Fixed** — `RATE` is `as const`, so a missing key is a compile error |
| 14 | Autosave shares a 30/hour bucket | **Fixed** — its own bucket at 600/hour |
| 15 | `shareGroup` is an account-existence oracle | Not fixed — accept or change the UX |
| 16 | Webhook skips the amount reconciliation | **Fixed** |
| 17 | `ownPath` accepts any `jobs/` path | **Fixed** — `ownJobPath` binds the job id |
| 18 | `queueRun` reads every run to name one | Not fixed |
| 19 | Tessellate runs as root | **Fixed** — uid 10001, image v64 |
| 20 | `createUploadIntent` can wipe a geometry's versions | Not fixed |
| 21 | `post_states` unbounded | Not fixed |

Tests added: `tests/test_clamp_paid_run.mjs` (37 checks) and seven cases in
`tests/test_security.mjs`, which now runs 74 against the emulator. Every new
check was mutation-tested — the rule or the clamp was broken on purpose and the
suite confirmed to fail — so none of them is passing vacuously.

Verified live on `turboflow-test` after deploying: the workbench still lists
groups, geometries, simulations and runs; a tunnel built on the non-root
container; and the version it wrote carries all four wheels by position with
`spin: true` on the two in the tunnel.

---

## Critical

### 1. A run is priced from two clamped fields, and the solver is sent the whole unclamped document

**Where:** `functions/src/jobs/queueRun.ts`, `functions/src/lib/pricing.ts`,
`services/simscale-job/simscale_job.py:run_spec_mode`, `firestore.rules` (simulations).

`queueRun` computes the price like this:

```ts
const params = clampRunParams({
  iteration_count: spec?.simulationControl?.endTime?.value,
  refine_level: levelForFineness(meshSpec?.sizing?.fineness ?? 5),
  inlet_velocity: inletSpeed(spec),
});
const price = chargeFor(user, params);
```

`clampRunParams` caps iterations at 3000 and the level at 5. But the run document
stores `spec_snapshot` and `mesh_snapshot` — the **whole** simulation document,
uncapped — and `run_spec_mode` posts those to SimScale verbatim. The clamped numbers
only ever reach the `jobs` document, where they decide the charge and nothing else.

`firestore.rules` lets a client write `spec` and `mesh_spec` directly:

```
allow update: if ... && mapOk(incoming().get('spec', null), 30)
                     && mapOk(incoming().get('mesh_spec', null), 30)
```

`mapOk` counts top-level keys. It does not look inside. `saveSimulation`'s zod schema
is not a control here either — every object in `simulations/spec.ts` is
`.passthrough()`, and a direct Firestore write skips the callable entirely.

**What this buys an attacker.** Set `simulationControl.endTime.value` to 200000 and
`mesh_spec.sizing.fineness` to 9.0. The price is computed as 3000 iterations at level
1 — 300 credits — and SimScale is asked for 200,000 iterations. `maxRunTime` is on the
same client-written document, so nothing stops it finishing. The same trick works
through `mesh_spec.refinements`, which `validateSetup` never looks at: a
`SURFACE_CUSTOM_SIZING` at fineness 10 over every face, priced at level 1.

**Fix.** Stop sending the client's document. Rebuild the spec server-side from clamped
parameters at queue time, or clamp `spec_snapshot` and `mesh_snapshot` in `queueRun`
before they are written: `endTime` to `LIMITS.iterations`, `maxRunTime` to a multiple
of it, every `refinements[].sizing.fineness` to at most the priced fineness, and
`numOfProcessors` to the plan cap. `validateSetup` should reject a refinement finer
than the domain it was priced against.

### 2. Everything runs as one service account with the keys to the whole project

**Where:** GCP IAM on `turboflow-test`.

`653114694502-compute@developer.gserviceaccount.com` holds:

| Role | What it gives |
|---|---|
| `roles/firebaseauth.admin` | mint a session for **any user**, read every account, change any email |
| `roles/storage.admin` | read, write and delete every object in the bucket — every team's CAD |
| `roles/datastore.user` | read and write all of Firestore, including the credit ledger |
| `roles/run.developer` | deploy new Cloud Run revisions — i.e. run arbitrary code |
| `roles/iam.serviceAccountTokenCreator` | impersonate other service accounts |
| `roles/cloudbuild.builds.builder` + `roles/artifactregistry.writer` | build and push images |

Every Cloud Function, the SimScale worker **and the geometry service** run as that one
identity. The geometry service is the problem: it parses attacker-supplied STEP, IGES
and STL through OpenCascade, a large C++ kernel with a long history of memory-safety
bugs, and `services/tessellate/Dockerfile` has no `USER` line, so it parses them as
root.

One memory-safety bug in a CAD parser is therefore full compromise: every user's
geometry, every user's account, the ledger, and a way to make it persistent by
deploying a new revision.

**Fix.** Three service accounts, each with only what it needs:

- geometry service: object read/write on its own prefix only, no Firestore write
  beyond the `rate` collection, no auth role at all;
- SimScale worker: Firestore write on `jobs` and `runs`, storage on results;
- functions: what they actually use.

Then remove the broad roles from the default compute account. Add a `USER 10001` to
the tessellate Dockerfile — `services/simscale-job/Dockerfile` already does it.

---

## High

### 3. Any signed-in account can write unlimited files to Storage, forever

**Where:** `storage.rules`.

```
match /jobs/{jobId}/{allPaths=**} {
  allow create: if signedIn() && resource == null && underLimit(60);
}
```

`resource == null` makes a path write-once, which stops overwriting someone else's
upload. It does nothing about *new* paths: any signed-in user can write a 60 MB object
to `jobs/<anything>/<anything>` as many times as they like. The same is true under
`users/{uid}/geometries/{anything}/raw.step` — the filename is constrained, the number
of geometry ids is not.

There is no per-account storage quota anywhere in the system, and nothing sweeps
orphaned uploads. Sign-up is free, so this is an unmetered write to your bill.

**Fix.** Count bytes per account (a `storage_used` field, written by an
`onObjectFinalized` trigger) and refuse `createUploadIntent` over a cap. Give the
`jobs/` prefix a lifecycle rule, and retire it once installed add-ins have moved to
`users/{uid}/`.

### 4. `exchangeFusionToken` is public, unauthenticated and unthrottled

**Where:** `functions/src/fusion/tokens.ts:116`.

Every POST does a Firestore document read before anything else. There is no rate limit
on it — `enforceRateLimit` is only reachable through `guard`, and this is an
`onRequest`. The token is 32 random bytes so brute force is not the risk; the cost is.
An unauthenticated script can drive Firestore reads and function invocations at
whatever rate it likes.

**Fix.** Rate limit by IP (or by token prefix) in the handler, and put Cloud Armor in
front of it.

Two smaller things in the same function:

- The `timingSafeEqual` at the end compares `hash` against `snap.id`, and the document
  was fetched *by* that hash, so the two are equal by construction. The check cannot
  fail and is not doing what the comment says. The real lookup — `.doc(hash).get()` —
  is not constant time. Harmless at 256 bits of entropy, but the comment should not
  claim a protection that is not there.
- `createFusionToken` reads `request.data.label` again after `guard` has already
  parsed it. Use the parsed value.

### 5. App Check is not enabled anywhere

Nothing in the codebase references App Check. Every callable, every Firestore rule and
every Storage rule is reachable from a script holding any account — and accounts are
free and unverified. App Check is the missing multiplier behind findings 3, 4 and 9.

**Fix.** Turn it on (reCAPTCHA Enterprise for the web app), set
`enforceAppCheck: true` on the callables, and enable enforcement on Firestore and
Storage once the clients are attested.

### 6. A leaked Fusion connection token can delete the whole account

**Where:** `functions/src/lib/guard.ts` (`humanOnly`), `firestore.rules`.

The `fusion` claim is checked in exactly three places: the profile-update rule, and the
two PayPal callables. Everything else treats a script session as the user. So a
connection token — designed to be pasted into a desktop add-in, and meant to be worth
less than a password — can `deleteGroup`, delete geometries, simulations and runs, and
queue runs that spend the account's credits.

**Fix.** Add `humanOnly: true` to `deleteGroup`, `copyGroup`, `shareGroup`,
`unshareGroup`, `createFusionToken` and `revokeFusionToken`, and add
`request.auth.token.get('fusion', false) != true` to the `delete` rules for groups,
geometries and simulations.

---

## Medium

### 7. Naming a group does not require being in it

**Where:** `firestore.rules` (geometries and simulations `create`),
`functions/src/geometry/createUploadIntent.ts`.

```
allow create: if signedIn() && incoming().user_id == request.auth.uid && ...
```

Nothing checks `group_id`. `createUploadIntent` has the same gap:
`group_id: data.group_id ?? null`, unchecked. `createSimulation` **does** check
(`mustReachGroup`), so the callable is stricter than the rule it sits beside.

Because the list rules let a group member read anything carrying their `group_id`, an
attacker who knows a group id can plant a geometry or a simulation, with a name of
their choosing, into someone else's workbench.

Group ids are 20-character Firestore auto-ids, so this needs the id from somewhere —
a shared link, a screenshot, a former collaborator. Real but not remotely triggerable.

**Fix.** Require membership in the create rules:

```
&& (incoming().get('group_id', null) == null || memberOf(incoming().group_id))
```

and call `mustReachGroup` in `createUploadIntent`.

### 8. A simulation can name another user's geometry

**Where:** `firestore.rules` (simulations), `functions/src/simulations/index.ts`.

`createSimulation` sets `geometry_id` with no ownership check, and the rules do not
constrain it either. The dangerous half is closed: `owned_path` in the worker requires
the STEP to sit under `users/{job owner}/`, so a run against someone else's car is
refused before SimScale sees it.

What still leaks is `checkSimulation`. It reads the named geometry document and its
`faces.json` with admin credentials, and returns messages like *"uses face 12, which
this version of the geometry does not have"*. That confirms a geometry id exists, and
discloses its face ids and current version.

**Fix.** Check the geometry is reachable by the caller in `createSimulation` and
`saveSimulation`, and in `checkSimulation` refuse to read a geometry the simulation's
owner cannot reach.

### 9. A collaborator with `edit` can drain the owner's credits

**Where:** `functions/src/jobs/queueRun.ts`.

The charge goes to `sim.get("user_id")` — the owner — and a `shared_with[uid] == 'edit'`
collaborator may queue. That is the intended design (the comment says so), but there is
no cap: the owner's `runJob` limit is 30/hour, so a collaborator can spend roughly 900
credits an hour and the owner finds out from their balance.

**Fix.** Either charge the person who pressed the button, or give `edit` a per-hour
credit budget on the group and show the owner who spent what.

### 10. Sharing a group does not give access to the files

**Where:** `storage.rules` vs `firestore.rules`.

The Firestore rules let a collaborator list and read a group's geometries. The Storage
rules do not:

```
match /users/{uid}/geometries/{geometryId}/{versionDir}/{fileName} {
  allow read: if signedIn() && request.auth.uid == uid && versionDir.matches('v[0-9]+');
}
```

Only the owner. So a collaborator sees the tree, opens a car, and the viewer fails on a
403 with no message that explains it. This is the same class of bug as the results
download that had never worked for anybody: a denied rule says only "Permission
denied".

**Fix.** Either resolve membership in the Storage rules (a `firestore.get` on the
group — note the existing comment that cross-service lookups have not worked reliably
in this project), or serve shared files through a callable that signs a short-lived
URL after checking membership. The second is more code and is the one that will
actually work.

---

## Low, and correctness gaps that matter

11. **Password sign-ups never receive the 50 credits.** `onUserCreate` grants 0 to an
    unverified provider and the comment says it is "topped up once the address is
    confirmed". Nothing does that — there is no other reference to `SIGNUP_BONUS` in
    the codebase. A user who signs up with a password and verifies their email gets
    nothing, permanently.
    *24 Sep 2026:* moot. Google is the only sign-in: `onUserCreate` refuses any other
    provider, every account starts with the 50, and `claimSignupBonus` (the fix
    for this) was deleted along with the password accounts it existed for.

12. **The CSP does nothing.** It is `Content-Security-Policy-Report-Only` with no
    `report-uri` or `report-to`, so violations are neither blocked nor recorded. Note
    that `script-src 'self'` will block the PayPal SDK when it is enforced, so
    `https://www.paypal.com` has to be added first.

13. **Rate limiting is silently optional.** `enforceRateLimit` returns without doing
    anything when the action is not in `RATE`, and `RATE` is typed
    `Record<string, RateRule>`, so `keyof typeof RATE` is just `string` — a typo or a
    new callable gets no limit and no compile error. Make `RATE` `as const` so the key
    type is real, and throw on an unknown action.

14. **Several unrelated callables share one 30/hour bucket.** `updateGroup`,
    `deleteGroup`, `copyGroup`, `createSimulation` and `saveSimulation` all pass
    `"createGroup"`. `saveSimulation` is called by the Workbench's autosave, so a
    normal editing session will start failing with "Too many createGroup requests"
    after 30 saves.

15. **`shareGroup` is an account-existence oracle.** `auth.getUserByEmail` →
    "No TurboFlow account with that email" tells a caller whether any address is
    registered, 60 times an hour. Return the same message either way and do the lookup
    after a uniform delay, or accept it as the cost of sharing by email.

16. **The PayPal webhook skips the amount reconciliation the capture path does.**
    `capturePayPalOrder` checks the captured value and currency against the intent;
    `paypalWebhook` calls `applyPurchase` on a verified event without that check. The
    grant comes from the server-written intent so it cannot be inflated, but the check
    belongs in both places. Also: webhook signature verification re-serialises the
    parsed body, which is the usual way this call fails — I could not test it here, so
    treat "the webhook works" as unverified.

17. **`ownPath` in `firestore.rules` accepts `jobs/<anything>/<anything>`** with no uid
    in it. The worker's `owned_path` catches a cross-tenant path, so this is a second
    lock holding rather than a hole, but the rule should still bind the uid.

18. **`queueRun` reads every run of a simulation** just to name "Run N". Unbounded read
    cost per queue, and two concurrent queues both get the same name.

19. **`copyGroup` breaks on a large group.** `childrenOf` loads everything into one
    `db.batch()`, and Firestore refuses a batch over 500 writes. The Storage copy then
    runs serially under a 300 s timeout and can stop halfway, leaving a group whose
    documents point at bytes that were never copied.

20. **`createUploadIntent` can wipe a geometry's history.** Called with an existing
    `geometry_id` and `kind: "raw"`, it merges `versions: {}` and `current_version: 0`
    over the document. Only the caller's own geometry, but it orphans the storage and
    breaks any queued run pinned to a version.

21. **`post_states` and `selections` are unbounded.** `selections` caps `step_ids` at
    5000; `post_states` has no size check at all.

---

## Still outstanding from earlier work

- ~~The temporary password login~~ **Done 24 Sep 2026.** `TestSignIn`, `.tf-test-signin`
  and the client's email/password helpers are deleted; the Email/Password provider is
  off on `turboflow-test`; `hi@hi.com` is disabled (not deleted, so its test groups
  remain); `onUserCreate` refuses any sign-up that is not Google.
- The IAM grant made during testing:

  ```
  gcloud iam service-accounts remove-iam-policy-binding \
    firebase-adminsdk-fbsvc@turboflow-test.iam.gserviceaccount.com \
    --member="user:shashanksaraswat93@gmail.com" \
    --role="roles/iam.serviceAccountTokenCreator" --project turboflow-test
  ```
- `tessellate` holds `min-instances=1` on 8 GiB, which is a real monthly bill.

## One thing I changed while deploying

The tessellate deploy went out with `--no-allow-unauthenticated`, which removed
`allUsers` from the service's invoker policy. It is now private: an unauthenticated
request to `/health` returns 403, and the Cloud Functions still reach it (proved by
the tunnel rebuild that ran afterwards).

`services/tessellate/main.py` says the service is deployed with `allUsers` because the
browser calls it directly. That is true of exactly one file: `public/workbench-classic.html`,
the old single-page workbench, which calls `/tessellate`, `/transform` and
`/infer_labels` from the browser. Nothing links to it — it is still served at
`/workbench-classic`, but no route, no nav item and no other page points at it. The
React Workbench goes through Cloud Functions for everything.

So locking it down removed a public attack surface and broke nothing that is reachable
through the product. Say the word if you want `allUsers` back.

---

## What I checked and found clean

- **The money path.** `writeCharge` / `writeRefund` / `writeReversal` derive everything
  from the ledger, never from the job document. Row ids are deterministic, so a replay
  is a no-op. `createPayPalOrder` derives the price server-side and records it where no
  client can reach it. `capturePayPalOrder` reconciles amount and currency, and checks
  the *capture* status rather than the order status. `applyPurchase` is idempotent by
  deleting the intent inside the granting transaction. The webhook verifies PayPal's
  signature before acting.
- **No client can set `cost`, `credits`, `status`, `validation` or `user_id`.** Checked
  in both the rules and every schema.
- **Path traversal.** `owned()` in the geometry service and `owned_path()` in the
  worker both reject `..` and absolute paths and require a `users/{uid}/` prefix. The
  trailing slash means one uid cannot prefix-match another.
- **`apply_ops`** is a whitelist of four operations, capped at 32, with bounded scale
  and axis values.
- **Injection.** No SQL. No `eval`, no `new Function`, no `dangerouslySetInnerHTML` in
  the app. The one `innerHTML` is `= ''`. Field paths built from user input
  (`shared_with.${uid}`) are constrained to `[A-Za-z0-9_-]{1,128}` by `docId`.
- **Secrets.** No private keys or service-account JSON in the repo. `SIMSCALE_API_KEY`
  comes from Secret Manager, not a plain env var. The PayPal secrets use
  `defineSecret`. The Firebase web API keys in `public/firebase-config.js` and the
  Fusion add-in are public by design — though they should carry HTTP-referrer
  restrictions in the GCP console, which I could not verify from here.
- **No source maps in `dist/`.** Checked.
- **`paypalBase()`** returns sandbox on any project but production, so a test deploy
  cannot charge a real card even if handed live credentials.
- **`onUserCreate`** is a blocking function that fails closed, so a Firestore outage
  refuses sign-up rather than creating an account with no record.
- **Security headers**: `nosniff`, `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN` are
  all set. Only the CSP is inert.

---

## Suggested order

1. Clamp `spec_snapshot` and `mesh_snapshot` at queue time (finding 1). Highest impact,
   smallest change.
2. Split the service accounts and drop `firebaseauth.admin` from the geometry service
   (finding 2). Biggest blast radius.
3. Turn on App Check (5), then add the storage quota (3) and the IP limit on
   `exchangeFusionToken` (4).
4. Add `humanOnly` to the destructive callables (6).
5. The group-membership checks (7, 8) and the sharing/storage gap (10), which are one
   piece of work.
6. The list from 11 onward, in whatever order suits.

---

# Pass 2: full-repository review

Second pass, same day, over the whole repository rather than the application
logic alone: build output, git history, dependencies, hosting headers, public
assets, CI, and the classes of bug the first pass did not look for (open
redirect, prototype pollution, ReDoS, SSRF, supply chain, CSP enforcement).

Everything below was run, not reasoned about. Where I could not verify
something it says **UNVERIFIED**.

## A. Executive summary

No evidence of compromise. No real secret has ever been committed to this
repository, the production bundle carries none, and there is no obfuscated
code, no unexpected dependency, no unknown outbound host, no CI pipeline to
subvert and no cron job.

Five new issues, one of them serious:

1. **An open redirect on the sign-in path** (High). `?next=/\evil.com` passed the
   guard in two places and resolved to `https://evil.com`. Proved, fixed,
   regression-tested, deployed.
2. **A public legacy page pulling three.js from a CDN with no integrity hash**
   (Medium). Removed from the served build.
3. **Two critical and six high dependency CVEs** in the functions image
   (Medium in practice). Patched.
4. **The CSP had never been enforced** (Medium). Now enforced, and verified
   live to block an unlisted CDN script and an injected inline script while
   leaving Google sign-in and the PayPal SDK working.
5. **The test build called production Cloud Functions** (Medium), sending a
   test-project ID token and the user's car data across. Fixed.

The largest remaining risk is unchanged from pass 1 and is not something I will
change without you: every workload still runs as one service account holding
`firebaseauth.admin`, `storage.admin` and `run.developer`.

## B. New findings

### N1. Open redirect in the sign-in flow. **High. Fixed.**

**Files:** `src/Shell.jsx:74`, `src/dashboard/DashboardApp.jsx:155`.

Both read `?next=` from the address bar and guarded it with

```js
next.startsWith("/") && !next.startsWith("//")
```

which reads as "a path, not a protocol-relative URL" and is not what it does.
Every browser normalises a backslash in the authority position to a forward
slash, so `/\evil.com` starts with `/`, does not start with `//`, and resolves
to `https://evil.com`. Proved against Node's URL parser, which is the same
WHATWG implementation the browsers use:

```
"/dashboard"       ALLOW   https://turboflow-test.web.app
"//evil.com"       block   https://evil.com
"/\evil.com"      ALLOW   https://evil.com    <-- OPEN REDIRECT
"/\/evil.com"     ALLOW   https://evil.com    <-- OPEN REDIRECT
```

**Impact.** A link on the genuine turboflow domain, in a sign-in flow, that
signs a person in and drops them on an attacker's page. That is the primitive a
credential-phishing page is built on, and the sign-in flow is the worst place in
the product to have one.

**Root cause.** Pattern-matching a URL instead of parsing it. Two hand-written
string checks, in two files, that had to agree with a URL grammar neither
author had in front of them.

**Fix.** One `safePath()` in `src/lib/pages.js`. It resolves the value against
the current origin, compares origins, and returns the path rebuilt from the
parsed parts, so what is navigated to is what was checked.

**Verification.** `tests/test_safe_path.mjs`, 36 checks, covering eleven
off-site spellings, four non-path schemes, rubbish input, seven ordinary paths
that must keep working, and an assertion that both call sites actually use the
helper. Mutation tested: restoring the original check, removing the check, and
comparing the origin without acting on it are all caught.

### N2. A legacy page served publicly, loading a CDN script with no integrity hash. **Medium. Fixed.**

**File:** `public/workbench-classic.html` and five scripts beside it.

The hand-written Workbench that came before `src/workbench/`. Nothing links to
it. It sat in `public/`, which Vite copies into `dist/` verbatim, so it was
served at `/workbench-classic` on every deploy. It:

- pulls `three@0.169.0` from `cdn.jsdelivr.net` with no Subresource Integrity;
- injects five more scripts with `document.write`;
- calls the geometry service directly from the browser, which is why that
  service was deployed to `allUsers`.

**Impact.** A bad day at jsdelivr runs somebody else's JavaScript on the
turboflow origin, where a signed-in user's Firebase session lives in IndexedDB.
Same-origin, so it can read the session and act as the user.

**Fix.** Moved to `legacy/`, which is not built, bundled or deployed. Kept
rather than deleted because three test files read it; `legacy/README.md` says
what has to be ported before it can go. `scripts/orphan-classes.mjs`,
`tests/test_chart.mjs` and `tests/test_compare.mjs` were repointed.

**Verification.** `curl https://turboflow-test.web.app/workbench-classic` -> 404.
`/cfd-setup.js` -> 404. `/` -> 200. Full suite green.

### N3. Two critical and six high CVEs in the deployed functions image. **Medium. Fixed.**

`npm audit` on `functions/`: 18 vulnerabilities, 2 critical, 6 high, all
transitive through firebase-admin.

| Severity | Package | Issue |
|---|---|---|
| critical | protobufjs | arbitrary code execution |
| critical | websocket-driver | resource-limit bypass via message compression |
| high | @grpc/grpc-js | malformed request crashes the server |
| high | brace-expansion, minimatch | ReDoS |
| high | fast-xml-parser | stack overflow |
| high | form-data | CRLF injection |
| high | node-forge | basicConstraints bypass in certificate verification |

**Fix.** `npm audit fix` (no major bumps). 18 -> 8, and every remaining one is
moderate and behind a `firebase-admin@14` major upgrade. Functions rebuild and
the spec suites pass.

**Remaining risk.** The 8 moderates. Upgrading firebase-admin to 14 is a
separate, testable change; it was not done here because a major bump of the SDK
every function depends on is not something to fold into a security pass
unverified.

### N4. The Content Security Policy had never been enforced. **Medium. Fixed.**

`firebase.json` served `Content-Security-Policy-Report-Only` with no
`report-uri` and no `report-to`. That is a policy that blocks nothing and
records nothing. It looked like a control in every review and was not one.

**Why it had not been switched on** turned out to be measurable rather than
mysterious. Listening for `securitypolicyviolation` on the live site gave
exactly two blockers: the inline theme-bootstrap script in the head of every
page, and `https://www.paypal.com/sdk/js`.

**Fix.** Enforced, with:

- the theme script pinned by `'sha256-gUex...'` rather than `'unsafe-inline'`,
  so that one script is allowed and an injected one is not;
- PayPal's origins added to `script-src`, `connect-src`, `frame-src` and
  `img-src`;
- `'unsafe-inline'` kept for **styles only**, knowingly: the front end is
  generated `React.createElement` with style objects on nearly every node, so
  removing them is a rewrite. An injected style can deface a page; it cannot
  read a token.

**Verification, on the deployed site:**

| Probe | Result |
|---|---|
| header | `Content-Security-Policy` (enforced) |
| PayPal SDK loads | yes, `window.paypal` is an object |
| script from `cdn.jsdelivr.net` | refused |
| injected inline script | did not execute |
| violations from normal use | none |

And `scripts/csp-audit.mjs` recomputes the hash from the build on every test
run, so editing the theme script fails a test instead of silently losing the
theme. Mutation tested against four regressions.

### N5. The test build called production Cloud Functions. **Medium. Fixed.**

**Files:** `src/components/InlineRaceCalc.jsx`, `src/views/SimulationsView.jsx`,
`src/views/LapCalcView.jsx`.

Two of the three race-time call sites had
`https://us-central1-turboflow-7b3ca.cloudfunctions.net/run_lap_calc` typed
into them, so the **test** site sent a test-project ID token, and the user's car
mass and drag figures, to the **production** project. The third had been fixed
but kept `|| 'turboflow-7b3ca'` as a fallback, which is the same hazard one line
smaller.

**Impact.** Cross-environment token transmission, and it breaks the property
`functions/src/lib/config.ts` works hard to guarantee on the server side: that a
test deploy cannot touch production.

**Fix.** All three derive the project from `window.FIREBASE_CONFIG.projectId`
and throw if it is absent. A build that cannot say which project it is now
stops rather than reaching for production.

### N6. Prototype-pollution hardening in the job normalizer. **Low. Fixed.**

`functions/src/lib/normalize.ts` iterates `Object.entries()` over a job
document, and `firestore.rules` lets a client create one with arbitrary extra
fields. A field called `constructor` made `EXPLICIT[key]` return the `Object`
function rather than undefined, so the patch got a key stringified from a
function; Firestore refuses that field name and `onJobPending` throws, failing
the run at the charge-and-dispatch step. `__proto__` on the plain `patch`
object assigns a prototype rather than a property.

Not exploitable beyond self-inflicted failure, and fixed anyway:
`Object.create(null)`, `Object.hasOwn`, and an explicit skip of the three
inherited names.

## C. What was checked and found clean

| Area | Result |
|---|---|
| Git history (47 commits, all branches) | Only Firebase **Web** API keys, which are public identifiers. No private keys, no service-account JSON, no payment or webhook secrets, no tokens. |
| Production bundle | Only the same web API keys. No source maps shipped. |
| CI/CD | None exists. No pipeline secrets, no untrusted-PR exposure. |
| Malicious code | No `eval`, no `new Function`, no obfuscation, no remote script loading, no hidden endpoints, no crypto-mining, no backdoor, no unexpected dependency. |
| Outbound hosts in shipped code | Google, Firebase, PayPal, the project's own Cloud Run. Nothing unknown. |
| npm audit, site | 0 vulnerabilities. |
| ReDoS | The one regex against attacker-controlled input (`RAW` in processGeometry, over a storage object name) is anchored with negated character classes. No backtracking. |
| SSRF | No endpoint takes a user-supplied URL. The geometry service takes storage paths, checked against a `users/{uid}/` prefix; PayPal and Discord URLs come from Secret Manager. |
| XSS | No `dangerouslySetInnerHTML`, no `eval`, no `document.write` in the app. The single `innerHTML` is `= ''`. |
| CSRF | Structurally not possible: the site sets **no cookies at all** (verified in the browser). Auth is a bearer token from IndexedDB, which a cross-site request cannot attach. |
| Security headers, live | HSTS with preload, Permissions-Policy, Referrer-Policy, nosniff, X-Frame-Options SAMEORIGIN, and now an enforced CSP with `frame-ancestors 'self'`. |
| Cache-Control | HTML `max-age=0, must-revalidate`; hashed assets immutable. No authenticated response is publicly cacheable. |
| Path traversal | `owned()` and `owned_path()` both reject `..` and absolute paths and require a `users/{uid}/` prefix, with the trailing slash that stops one uid prefix-matching another. |
| Command execution | None. The only `exec(` in the backend is `RegExp.prototype.exec`. |

## D. Secret audit

Values are never printed here.

| Secret type | Location | Exposed? | Rotation required? | Done? |
|---|---|---|---|---|
| Firebase Web API key (test) | `public/firebase-config.js`, bundle | Public by design | No | n/a |
| Firebase Web API key (prod) | Fusion add-in source; was also a comment in the test config | Public by design | No, but **restrict it** (see J) | Comment removed |
| Firebase Storage download token | `src/views/DocsView.jsx`, in the bundle | Yes, by design (add-in download) | Your call: it is a bearer token for one object | No |
| SimScale API key | Secret Manager, injected into the Cloud Run job | No | Only if it has ever been pasted into a chat | UNVERIFIED |
| PayPal client id / secret / webhook id | Secret Manager via `defineSecret` | No | No | n/a |
| Discord webhook URL | Secret Manager | No | No | n/a |
| Service-account keys | None in the repo | No | n/a | n/a |

## E. Tests added in this pass

| Test | Checks | Mutation tested |
|---|---|---|
| `tests/test_safe_path.mjs` | 36 | 3 mutations, all caught |
| `scripts/csp-audit.mjs` | policy + every inline script hash | 4 mutations, all caught |

Both are in `tests/run-all.sh`. The whole suite is green: 15 suites, 6 audits.

## F. Backup and restore

**Set up on turboflow-test, 23 Sep. Restore from a backup NOT TESTED.**

- Daily backup schedule, 14-day retention.
- Point-in-time recovery, 7-day window. Verified: a document read back as it
  was at an earlier minute (`readTime`).
- Delete protection on the database.

The first scheduled backup lands within 24 hours of setup, so restoring one has
not been tried. A restore creates a new database; do it once into a scratch
database id and compare a few documents before relying on it. Production
(turboflow-7b3ca) has none of this yet - the same three commands apply there.

## G. Manual actions, in the order I would do them

1. **Split the service accounts.** Pass 1, finding 2. Still the largest risk.
2. **Turn on App Check** (reCAPTCHA Enterprise keys, console).
3. **Restrict the Firebase Web API keys** to HTTP referrers for the two sites,
   in the GCP console. They are public identifiers, but an unrestricted one
   lets anyone burn your Identity Toolkit quota. **UNVERIFIED** from here.
4. ~~**Remove the test sign-in**~~ **Done 24 Sep 2026**: component, CSS and client
   helpers deleted, provider off on turboflow-test, `hi@hi.com` disabled, and
   `onUserCreate` refuses non-Google sign-ups.
5. **Revoke the IAM grant** from pass 1.
6. **Decide on the Storage download token** in `DocsView.jsx`.
7. ~~Set a Firestore TTL policy on the `rate` collection~~ - **done on
   turboflow-test 23 Sep** (`expire_at`, ACTIVE). Production still needs it.
8. **Backups**: schedule, point-in-time recovery and delete protection are on
   for turboflow-test (section F). Still to do: one test restore, and the same
   setup on production.
9. Then the remaining pass-1 items: storage quota, collaborator spend limits,
   sharing and Storage, and the small list from 18 onward.

