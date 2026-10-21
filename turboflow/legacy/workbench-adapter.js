// Firestore behind the Supabase-shaped calls the Workbench already makes.
//
// workbench.html is 136 KB of viewport, tree, panels and shaders, and almost
// none of it cares where the data comes from. The part that does is about fifty
// lines: five table reads, a realtime subscription, a storage upload, and the
// auth session. This file answers those, so the Workbench itself barely changes.
//
// It replaces supabase-firebase-shim.js, which ran the other way: that one
// faked the Firebase compat API on top of Supabase so the old compiled app
// could run there. Supabase is gone, so that file is gone with it.
//
// Two things get better in the move. Firestore's realtime is per-document and
// incremental rather than "any change anywhere, refetch all five tables". And
// onSnapshot needs no channel-stacking guard, so the bug described at
// workbench.html:1533 cannot happen here.
//
// Load AFTER the firebase compat SDKs and firebase-config.js, and BEFORE
// workbench.html's own inline script.
(function (win) {
  "use strict";

  if (!win.firebase) throw new Error("workbench-adapter.js: load the Firebase compat SDKs first.");
  if (!win.FIREBASE_CONFIG) throw new Error("workbench-adapter.js: load firebase-config.js first.");

  // Served from localhost means a developer is working, and a developer working
  // should not be signing in to production, spending real credits, or writing
  // rows into the live database. Everything below points at the emulators
  // instead, keyed on where the page came from rather than on a build flag —
  // the failure it prevents is one nobody notices until afterwards.
  const LOCAL = ["localhost", "127.0.0.1", "[::1]"].indexOf(win.location.hostname) !== -1;

  // The emulator suite runs in single-project mode as demo-turboflow (see the
  // `emulate` script), so the local app has to claim that project id rather than
  // the one in firebase-config.js.
  const config = LOCAL
    ? Object.assign({}, win.FIREBASE_CONFIG, {
        projectId: "demo-turboflow",
        storageBucket: "demo-turboflow.appspot.com",
      })
    : win.FIREBASE_CONFIG;

  if (!firebase.apps.length) firebase.initializeApp(config);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const storage = firebase.storage();
  const functions = firebase.functions();

  if (LOCAL) {
    auth.useEmulator("http://127.0.0.1:9099", { disableWarnings: true });
    db.useEmulator("127.0.0.1", 8080);
    storage.useEmulator("127.0.0.1", 9199);
    functions.useEmulator("127.0.0.1", 5001);
    console.info("workbench-adapter: using the local Firebase emulators.");
  }

  const uid = () => auth.currentUser && auth.currentUser.uid;

  // Collections whose rows all carry user_id, so every read can be scoped to the
  // caller. The rules require exactly this filter before they permit a list.
  const OWNED = new Set(["projects", "geometries", "simulations", "jobs"]);

  // ── value conversion ───────────────────────────────────────────────────────
  // Postgres handed back ISO strings for timestamps and the Workbench reads them
  // as strings (`new Date(user.unlimited_until)`, date sorting on created_at).
  // Firestore hands back Timestamp objects, so convert on the way out and the
  // Workbench needs no changes.
  function fromFirestore(v) {
    if (v == null) return v;
    if (typeof v.toDate === "function") return v.toDate().toISOString();
    if (Array.isArray(v)) return v.map(fromFirestore);
    if (typeof v === "object" && v.constructor === Object) {
      const o = {};
      for (const k in v) o[k] = fromFirestore(v[k]);
      return o;
    }
    return v;
  }

  // Supabase rows carry their primary key in the row. Firestore keeps it on the
  // snapshot, so put it back — the Workbench indexes everything by `id`.
  const rowOf = (doc) => Object.assign({ id: doc.id }, fromFirestore(doc.data()));

  const ok = (data) => ({ data, error: null });
  const bad = (e) => ({ data: null, error: { message: (e && e.message) || String(e) } });

  // ── query builder ──────────────────────────────────────────────────────────
  // Only the shapes workbench.html actually uses. A thenable rather than a
  // Promise so `.order(...)` and `.eq(...)` can still be chained after
  // `.select()`, exactly as the Supabase client allows.
  function table(name) {
    return {
      select(columns) {
        const q = {
          _orderBy: null,
          _asc: true,
          _eq: [],
          order(col, opts) {
            this._orderBy = col;
            this._asc = !opts || opts.ascending !== false;
            return this;
          },
          eq(col, val) {
            this._eq.push([col, val]);
            return this;
          },
          async maybeSingle() {
            const r = await this._run();
            if (r.error) return r;
            return ok(r.data.length ? r.data[0] : null);
          },
          async single() {
            const r = await this.maybeSingle();
            if (r.error) return r;
            if (!r.data) return bad(new Error("No matching row."));
            return r;
          },
          async _run() {
            try {
              const me = uid();
              if (!me) return bad(new Error("Not signed in."));

              // users is read by document id, never listed — the rules forbid
              // listing it at all, and there is only ever one row of interest.
              if (name === "users") {
                const snap = await db.collection("users").doc(me).get();
                return ok(snap.exists ? [Object.assign({ id: snap.id }, fromFirestore(snap.data()))] : []);
              }

              let ref = db.collection(name);
              if (OWNED.has(name)) ref = ref.where("user_id", "==", me);
              for (const [col, val] of this._eq) {
                // `id` is the document id in Firestore, not a field.
                if (col === "id") {
                  const snap = await db.collection(name).doc(String(val)).get();
                  if (!snap.exists) return ok([]);
                  const row = rowOf(snap);
                  return ok(row.user_id && row.user_id !== me ? [] : [row]);
                }
                ref = ref.where(col, "==", val);
              }
              if (this._orderBy) ref = ref.orderBy(this._orderBy, this._asc ? "asc" : "desc");

              const snap = await ref.get();
              return ok(snap.docs.map(rowOf));
            } catch (e) {
              return bad(e);
            }
          },
          then(resolve, reject) {
            return this._run().then(resolve, reject);
          },
        };
        // `columns` is ignored on purpose: Firestore has no column projection,
        // and every caller here either wants the whole row or a fixed handful
        // of fields off the user document.
        void columns;
        return q;
      },

      insert(values) {
        const run = async () => {
          try {
            const me = uid();
            if (!me) return bad(new Error("Not signed in."));

            const payload = Object.assign({}, values);
            const explicitId = payload.id;
            delete payload.id;

            // The rules check user_id on create, so never let it be absent or
            // someone else's.
            payload.user_id = me;
            if (!payload.created_at) {
              payload.created_at = firebase.firestore.FieldValue.serverTimestamp();
            }

            const ref = explicitId
              ? db.collection(name).doc(String(explicitId))
              : db.collection(name).doc();
            await ref.set(payload);

            // Read back so the caller sees server-applied defaults, the same way
            // `.insert().select().single()` did against Postgres.
            const snap = await ref.get();
            return ok([rowOf(snap)]);
          } catch (e) {
            return bad(e);
          }
        };
        return {
          select() {
            return {
              async single() {
                const r = await run();
                if (r.error) return r;
                return ok(r.data[0]);
              },
              then(res, rej) { return run().then(res, rej); },
            };
          },
          then(res, rej) { return run().then(res, rej); },
        };
      },

      update(patch) {
        return {
          async eq(col, val) {
            try {
              if (col !== "id") return bad(new Error("update supports .eq('id', …) only."));
              const clean = Object.assign({}, patch);
              // Ownership is not editable, whatever the caller passed.
              delete clean.user_id;
              delete clean.id;
              await db.collection(name).doc(String(val)).update(clean);
              return ok(null);
            } catch (e) {
              return bad(e);
            }
          },
        };
      },
    };
  }

  // ── realtime ───────────────────────────────────────────────────────────────
  // One onSnapshot per collection, scoped to the caller. The Workbench passes
  // `refresh` as the handler and refetches, which is what it did before; the
  // difference is that Firestore only wakes us for rows we can actually see.
  function channel() {
    const unsubs = [];
    const tables = [];
    return {
      on(_event, opts, handler) {
        tables.push([opts && opts.table, handler]);
        return this;
      },
      subscribe(statusCb) {
        const me = uid();
        if (!me) {
          if (statusCb) statusCb("CHANNEL_ERROR");
          return this;
        }
        for (const [name, handler] of tables) {
          if (!name) continue;
          let first = true;
          const ref = OWNED.has(name)
            ? db.collection(name).where("user_id", "==", me)
            : db.collection(name);
          unsubs.push(ref.onSnapshot(
            () => {
              // The first callback is the current contents, which the caller has
              // just loaded. Firing then would refetch everything for nothing.
              if (first) { first = false; return; }
              handler();
            },
            () => { if (statusCb) statusCb("CHANNEL_ERROR"); },
          ));
        }
        if (statusCb) statusCb("SUBSCRIBED");
        return this;
      },
      unsubscribe() {
        unsubs.forEach((u) => u());
        unsubs.length = 0;
      },
    };
  }

  // ── storage ────────────────────────────────────────────────────────────────
  // The bucket argument is ignored: Supabase namespaces by bucket, Firebase by
  // path, and the paths the Workbench builds already carry the owner.
  function bucket() {
    return {
      async upload(path, file) {
        try {
          await storage.ref(path).put(file);
          return { data: { path }, error: null };
        } catch (e) {
          return bad(e);
        }
      },
      async remove(paths) {
        // Best effort: a failure here means an orphaned file, not a broken run,
        // and the caller is usually already handling another error.
        await Promise.all((paths || []).map((p) =>
          storage.ref(p).delete().catch(() => {})));
        return { data: null, error: null };
      },
      async createSignedUrl(path) {
        try {
          // Firebase download URLs are already tokenised and are governed by the
          // storage rules, so this is the equivalent of a signed URL. The expiry
          // argument has no counterpart and is ignored.
          const url = await storage.ref(path).getDownloadURL();
          return ok({ signedUrl: url });
        } catch (e) {
          return bad(e);
        }
      },
    };
  }

  // ── auth ───────────────────────────────────────────────────────────────────
  // Supabase's session object, filled from the Firebase user. `access_token` is
  // the Firebase ID token, which is what the tessellation service verifies.
  async function sessionOf(user) {
    if (!user) return null;
    return {
      user: { id: user.uid, email: user.email },
      access_token: await user.getIdToken(),
    };
  }

  // getSession() is called during boot, possibly before Firebase has restored
  // the persisted user. Waiting for the first auth state event avoids showing
  // the sign-in gate to someone who is already signed in.
  let firstAuth = new Promise((resolve) => {
    const stop = auth.onAuthStateChanged((u) => { stop(); resolve(u); });
  });

  const authApi = {
    async getSession() {
      const user = auth.currentUser || await firstAuth;
      return { data: { session: await sessionOf(user) }, error: null };
    },
    onAuthStateChange(cb) {
      // Only report actual transitions.
      //
      // Firebase calls back immediately with the restored user, or with null
      // when there is none. Supabase does not call that "SIGNED_OUT" — it is
      // the initial state, not a sign-out. Reporting it as one sends
      // workbench.html:2736 into location.reload(), which loads a page with no
      // session, which reports SIGNED_OUT again: the page reloads forever.
      //
      // Firebase also calls back on every token refresh, roughly hourly. Those
      // are not transitions either, and passing them through would re-run boot()
      // for no reason.
      let seen = false;
      let signedIn = false;
      const stop = auth.onAuthStateChanged((u) => {
        const now = !!u;
        if (!seen) { seen = true; signedIn = now; return; }
        if (now === signedIn) return;
        signedIn = now;
        cb(now ? "SIGNED_IN" : "SIGNED_OUT", null);
      });
      return { data: { subscription: { unsubscribe: stop } } };
    },
    async signInWithOAuth(opts) {
      try {
        const provider = new firebase.auth.GoogleAuthProvider();
        void opts;
        await auth.signInWithPopup(provider);
        return { data: null, error: null };
      } catch (e) {
        return bad(e);
      }
    },
    // No email or password methods. TurboFlow signs in with Google and nothing
    // else, and the Workbench is a TurboFlow page rather than an application
    // with an account system of its own.
    async signOut() {
      try {
        await auth.signOut();
        return { error: null };
      } catch (e) {
        return { error: { message: e.message } };
      }
    },
  };

  // ── callables ──────────────────────────────────────────────────────────────
  // Supabase edge functions were kebab-case; the Firebase callables are
  // camelCase. Mapped here so workbench.html keeps its existing call.
  const CALLABLE = {
    "refund-job": "refundJob",
    "submit-job": "submitJob",
    "start-job": "startJob",
    "create-upload-intent": "createUploadIntent",
  };

  const functionsApi = {
    async invoke(name, opts) {
      try {
        const fn = functions.httpsCallable(CALLABLE[name] || name);
        const res = await fn((opts && opts.body) || {});
        return ok(res.data);
      } catch (e) {
        return bad(e);
      }
    },
  };

  win.sb = {
    from: table,
    channel,
    auth: authApi,
    storage: { from: bucket },
    functions: functionsApi,
    // Handy for debugging in the console; nothing in the Workbench uses these.
    _firebase: { auth, db, storage, functions },
  };
})(typeof window !== "undefined" ? window : globalThis);
