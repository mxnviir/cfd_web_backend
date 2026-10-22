// The page shell: header, sidebar, credit balance, auth modal and footer.
//
// This was the App component, which also held a `view` state variable and a
// chain of `view === 'x' && <XView/>` to pick a screen. That chain is gone: the
// screen is a prop now, so each page imports one view and the bundler can give
// that page only the code it needs.
import React, { useState, useEffect } from "react";
// Loaded on demand, not at parse time.
//
// The Firebase client is 106 KB gzipped — most of it Firestore — and it is by
// far the largest thing on the page. A page like /terms or /docs never touches
// it, and even on a page that does, nothing can be shown until React has
// rendered anyway. Importing it dynamically lets the page paint first and the
// credit balance fill in a moment later, instead of holding the whole render
// behind a download.
//
// Pages that genuinely need it — billing, simulations — import it directly in
// their own view, so it is in their bundle from the start.
let firebasePromise = null;
const loadFirebase = () => (firebasePromise ??= import("./lib/firebase"));
import { PAGES, go, safePath } from "./lib/pages";
import { Ic } from "./lib/icons";
import { AuthModal } from "./components/AuthModal";

const IconRuns = () => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);
const IconWorkbench = () => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
    <path d="M8 2 14 5v6l-6 3-6-3V5z" /><path d="M2 5l6 3 6-3M8 8v6" />
  </svg>
);
const IconClock = () => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
  </svg>
);

// The sidebar, as data. It was three copies of the same .map, one per group,
// each a <button> that set location.href: a link that could not be opened in
// a new tab, middle-clicked or read by a crawler. They are links now.
const NAV = [
  { label: null, items: [
    ["home", "Home", Ic.Home],
    // The garage (/dashboard) is the way into the Workbench: every group, with
    // its best result, and a click opens that group's Workbench. One link, not
    // a "Dashboard" and a "Workbench" that both ended up on the same page.
    ["dash", "Workbench", IconWorkbench],
    ["simulations", "My simulations", IconRuns],
    ["lapcalc", "Race time calculator", IconClock],
    ["billing", "Billing", Ic.Billing],
    ["docs", "Setup guide", Ic.Docs],
  ] },
  { label: "Programmes", items: [
    ["sponsorship", "Sponsorship", Ic.Trophy],
    ["mentorship", "Mentorship", Ic.Trophy],
    ["modelling", "Modelling services", Ic.Wrench],
  ] },
  { label: "Legal", items: [
    ["privacy", "Privacy policy", Ic.Docs],
    ["terms", "Terms of service", Ic.Docs],
    ["refund", "Refund policy", Ic.Billing],
    ["spolicy", "Sponsorship policy", Ic.Trophy],
  ] },
];

// Asked once, on the first sign-in, before anything else. A form, so Enter
// submits it; the failure used to be an alert() and is a line under the field.
function TeamNameDialog({ onSave }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const name = e.currentTarget.elements.team.value.trim();
    if (!name) { setError("Enter your team's name."); return; }
    setBusy(true);
    setError("");
    const res = await onSave(name);
    if (!res.ok) { setError(res.message); setBusy(false); }
  };
  return (
    <div className="modal-overlay">
      <form className="modal-card modal-form" role="dialog" aria-modal="true" aria-labelledby="team-title" onSubmit={submit}>
        <h2 id="team-title" className="t-h2">Set up your team</h2>
        <p className="t-small">Enter your team's official name to start running simulations.</p>
        <label className="field-label" htmlFor="team-name">Team name</label>
        <input id="team-name" name="team" type="text" className="input-field field-input"
          placeholder="e.g. Red Rocket Racing" autoFocus />
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <button className="btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? "Saving..." : "Save team name"}
        </button>
      </form>
    </div>
  );
}

export const Shell = ({ view, View }) => {
  // Theme choice: "system" follows the OS, the other two override it. Stored so
  // it survives a reload, and mirrored onto <html> where the CSS reads it.
  const [themeChoice, setThemeChoice] = React.useState(function () {
    try { return localStorage.getItem("turboflow-theme") || "system"; } catch (e) { return "system"; }
  });
  const setTheme = React.useCallback(function (mode) {
    setThemeChoice(mode);
    try {
      if (mode === "system") { localStorage.removeItem("turboflow-theme"); delete document.documentElement.dataset.theme; }
      else { localStorage.setItem("turboflow-theme", mode); document.documentElement.dataset.theme = mode; }
    } catch (e) {}
  }, []);

  // The screen is decided by the URL now, not by state. setView used to
  // change a variable and leave the address bar alone, which is why no
  // screen could be linked to or reloaded; it navigates instead.
  const setView = go;
  const [credits, setCredits] = useState(50);
  const [passUntil, setPassUntil] = useState(0);
  const [passStartedAt, setPassStartedAt] = useState(0);
  const [job, setJob] = useState(null);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [user, setUser] = useState(null);
  const [showAuth, setShowAuth] = useState(false);
  const [authReason, setAuthReason] = useState('');
  const openAuth = reason => {
    setAuthReason(reason || '');
    setShowAuth(true);
  };
  /*
   * ?signin=1 opens the site's own sign-in; ?next= says where to go after.
   *
   * This is how the dashboard asks for a sign-in. It used to draw its own
   * screen, which meant two sign-ins with two designs - and the second one
   * was a bare box I made up rather than the modal with the logo, the Google
   * button and the terms line that the site has always used. There is one
   * sign-in, it lives here, and other pages send people to it.
   */
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("signin") === "1" && !isSignedIn) openAuth(q.get("reason") || "");
  }, [isSignedIn]);

  useEffect(() => {
    if (!isSignedIn) return;
    const next = new URLSearchParams(location.search).get("next");
    // Same-origin paths only, decided by resolving the value rather than by
    // looking at how it starts: `/\evil.com` passed the old test and opened
    // https://evil.com. safePath returns null-safe fallbacks, so an unusable
    // value simply does not navigate.
    const dest = next ? safePath(next, "") : "";
    if (dest) location.assign(dest);
  }, [isSignedIn]);

  const requireAuth = (reason, cb) => {
    if (isSignedIn) {
      cb && cb();
      return true;
    }
    openAuth(reason);
    return false;
  };

  // Firebase Auth integration: listen for auth state changes
  useEffect(() => {
    let unsubUserDoc = null;
    let unsubscribe = null;
    let stopped = false;

    loadFirebase().then(({ auth, db, firebase }) => {
      // The component can unmount while the import is still in flight.
      if (stopped) return;
      unsubscribe = auth.onAuthStateChanged(async u => {
      // clean up previous user doc listener on auth change
      if (unsubUserDoc) {
        unsubUserDoc();
        unsubUserDoc = null;
      }
      if (u) {
        const initials = (u.displayName || '').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase() || (u.email ? u.email[0].toUpperCase() : 'U');
        setIsSignedIn(true);
        try {
          const userRef = db.collection('users').doc(u.uid);
          const doc = await userRef.get();
          let teamName = null;
          if (!doc.exists) {
            // A new account. The server writes its document (ensureAccount in
            // functions/src/users), and the listener below fills the balance
            // in the moment it lands, so there is nothing to invent here.
            // Not awaited: the page carries on while it is made.
            teamName = null;
            setCredits(0);
            loadFirebase()
              .then(({ functions }) => functions.httpsCallable('ensureAccount')({}))
              .catch((err) => console.warn('Could not create the account record', err));
          } else {
            const data = doc.data() || {};
            teamName = data.teamName || null;
            if (data.credits !== undefined) setCredits(data.credits);
            // lastSeen used to be written on every page load. With one page
            // per screen that is a database write per navigation, for a field
            // no screen displays.
          }
          setUser({
            name: u.displayName || u.email,
            email: u.email,
            initials,
            photoURL: u.photoURL,
            uid: u.uid,
            teamName,
            sponsored: !!(doc.exists && (doc.data() || {}).sponsored)
          });

          // Live listener: credits update instantly when Cloud Function deducts them
          unsubUserDoc = userRef.onSnapshot(snap => {
            if (snap.exists) {
              const d = snap.data() || {};
              if (d.credits !== undefined) setCredits(d.credits);
              var _toMs = function (t) { return t && typeof t.toMillis === 'function' ? t.toMillis() : (t && t.seconds ? t.seconds * 1000 : 0); };
              setPassUntil(_toMs(d.unlimitedUntil));
              setPassStartedAt(_toMs(d.unlimitedStartedAt));
              if (d.teamName !== undefined) setUser(prev => prev ? {
                ...prev,
                teamName: d.teamName
              } : prev);
              if (d.sponsored !== undefined) setUser(prev => prev ? {
                ...prev,
                sponsored: !!d.sponsored
              } : prev);
            }
          });
        } catch (e) {
          console.warn('Failed to read/persist user profile:', e);
          setUser({
            name: u.displayName || u.email,
            email: u.email,
            initials,
            photoURL: u.photoURL,
            uid: u.uid
          });
        }
      } else {
        setIsSignedIn(false);
        setUser(null);
        setCredits(0);
        setPassUntil(0);
        setPassStartedAt(0);
      }
    });
    });

    return () => {
      stopped = true;
      if (unsubscribe) unsubscribe();
      if (unsubUserDoc) unsubUserDoc();
    };
  }, []);
  const signIn = async () => {
    // The popup fallback lives in lib/signIn now, because the dashboard needs
    // the same behaviour and two copies of it would be two copies to get
    // wrong. Still lazily imported: this is the marketing chrome and most
    // visitors never sign in, so Firebase stays out of the first load.
    const { signInWithGoogle } = await import("./lib/signIn");
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error('Sign-in error', err);
      alert('Sign-in failed: ' + (err && err.message ? err.message : err));
    }
  };
  const signOut = async () => {
    try {
      const { auth } = await loadFirebase();
      await auth.signOut();
    } catch (err) {
      console.warn('Sign-out failed', err);
    }
  };
  const handleSaveTeamName = async name => {
    if (!user || !user.uid) return { ok: false, message: 'You are signed out. Sign in again and retry.' };
    try {
      const { db } = await loadFirebase();
      const userRef = db.collection('users').doc(user.uid);
      await userRef.update({
        teamName: name
      });
      setUser(prev => ({
        ...prev,
        teamName: name
      }));
      return { ok: true };
    } catch (err) {
      console.error('Error saving team name:', err);
      return { ok: false, message: 'The team name was not saved. Check your connection and try again.' };
    }
  };
  const handleSaveProfile = async profile => {
    if (!user || !user.uid) {
      return {
        ok: false,
        message: 'Not signed in'
      };
    }
    try {
      const { db } = await loadFirebase();
      const userRef = db.collection('users').doc(user.uid);
      await userRef.update({
        teamName: profile.teamName || null,
        region: profile.region || null,
        contactEmail: profile.contactEmail || user && user.email || null
      });
      setUser(prev => ({
        ...prev,
        teamName: profile.teamName || prev.teamName,
        region: profile.region || prev.region,
        contactEmail: profile.contactEmail || prev.contactEmail
      }));
      return {
        ok: true,
        message: 'Profile saved'
      };
    } catch (err) {
      console.error('Error saving profile:', err);
      return {
        ok: false,
        message: 'Could not save profile. Please try again.'
      };
    }
  };
  /*
   * The sidebar starts collapsed on a narrow window.
   *
   * It is 256 px wide and it kept that width at every size, so at 600 px it
   * took 43% of the screen and left the content 344 px to live in. The page is
   * a horizontal strip of slides, so the slides did not reflow into that - they
   * were squeezed, and the prose inside them came out 87 px wide and clipped
   * mid-sentence. That is what the site looks like on a phone.
   *
   * Collapsed it is 56 px, which leaves 544 of 600 for the content.
   *
   * 900 px because that is where the three-column content inside a slide stops
   * fitting beside a full sidebar, not because it is a round number.
   */
  const NARROW = "(max-width: 900px)";
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !(typeof window !== "undefined" && window.matchMedia(NARROW).matches),
  );

  // Collapse when the window becomes narrow. Deliberately one-way: it never
  // forces the sidebar open again, because someone who collapsed it on a wide
  // screen meant it.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mq = window.matchMedia(NARROW);
    const onChange = (e) => { if (e.matches) setSidebarOpen(false); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const passActive = passUntil > Date.now();
  const passDaysLeft = passActive ? Math.ceil((passUntil - Date.now()) / 86400000) : 0;
  const passTotalDays = passActive ? Math.max(passDaysLeft, passStartedAt > 0 ? Math.round((passUntil - passStartedAt) / 86400000) : passDaysLeft) : 0;
  const viewProps = {
    setView, setJob, user, credits, setCredits, isSignedIn,
    onRequireAuth: requireAuth,
  };
  const passPct = (passActive && passTotalDays > 0) ? Math.max(0, Math.min(100, Math.round(passDaysLeft / passTotalDays * 100))) : 0;
  const initials = user && user.initials || 'U';
  return (
    <div className="main-grid site-frame">
      {/* First in the tab order, visible only when focused: without it a
          keyboard user tabs through every sidebar link before reaching the
          page. */}
      <a className="skip-link" href="#main-content">Skip to content</a>
      {showAuth && <AuthModal reason={authReason} onClose={() => setShowAuth(false)} onSignIn={signIn} />}
      {user && !user.teamName && <TeamNameDialog onSave={handleSaveTeamName} />}

      <aside className="site-nav" data-open={sidebarOpen}>
        <div className="site-nav-top">
          <button type="button" className="site-nav-toggle" onClick={() => setSidebarOpen(o => !o)}
            aria-expanded={sidebarOpen} aria-label={sidebarOpen ? 'Collapse the menu' : 'Expand the menu'}>
            <span /><span /><span />
          </button>
          {sidebarOpen && !isSignedIn && (
            <button type="button" className="btn-google btn-sm site-nav-signin"
              onClick={() => openAuth('Sign in to manage simulations, track credits, and purchase plans.')}>
              {Ic.Google()} Sign in with Google
            </button>
          )}
          {sidebarOpen && isSignedIn && (
            <div className="site-nav-user">
              {user && user.photoURL ? (
                <img className="site-nav-avatar" src={user.photoURL} referrerPolicy="no-referrer"
                  alt={user.name ? `${user.name}'s account photo` : 'Your account photo'}
                  onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }} />
              ) : null}
              <div className="site-nav-avatar" style={{ display: user && user.photoURL ? 'none' : 'flex' }}>{initials}</div>
              <div className="site-nav-who">
                <div className="site-nav-name">{user && (user.teamName || user.name) || ''}</div>
                <div className="site-nav-email">{user && user.email || ''}</div>
              </div>
              <button type="button" className="btn-quiet btn-icon btn-sm" onClick={signOut} aria-label="Sign out" title="Sign out">
                {Ic.SignOut()}
              </button>
            </div>
          )}
          {!sidebarOpen && isSignedIn && <div className="site-nav-avatar">{initials}</div>}
        </div>

        <nav className="site-nav-links" aria-label="Site">
          {NAV.map(({ label, items }) => (
            <React.Fragment key={label || 'main'}>
              {label && <div className="site-nav-group">{sidebarOpen ? label : null}</div>}
              {items.map(([id, name, icon]) => (
                <a key={id} href={PAGES[id]}
                  className={'sidebar-link' + (view === id ? ' sidebar-link-active' : '')}
                  aria-current={view === id ? 'page' : undefined}
                  aria-label={sidebarOpen ? undefined : name} title={sidebarOpen ? undefined : name}>
                  {icon()}{sidebarOpen && <span>{name}</span>}
                </a>
              ))}
            </React.Fragment>
          ))}
        </nav>

        {sidebarOpen && (
          <div className="site-nav-foot">
            {/* The balance under its own label. The theme picker used to sit
                between the two, so "Credit balance" headed a row of theme
                buttons and the number came after them. */}
            <div className="t-caption">Credit balance</div>
            {isSignedIn ? (
              <>
                <div className="site-nav-balance">
                  <span className="t-data-lg">{credits.toLocaleString()}</span>
                  <span className="t-unit">credits</span>
                </div>
                {passActive && (
                  <div className="site-nav-pass">
                    <div className="site-nav-pass-head">
                      <span>Unlimited pass</span>
                      <span className="t-data">{passDaysLeft + (passDaysLeft === 1 ? ' day left' : ' days left')}</span>
                    </div>
                    <div className="meter"><div style={{ width: passPct + '%' }} /></div>
                    <div className="t-caption">{passDaysLeft + ' of ' + passTotalDays + ' days'}</div>
                  </div>
                )}
                <a href={PAGES.billing} className="btn-quiet btn-sm site-nav-add">Add credits</a>
              </>
            ) : (
              <div className="site-nav-locked">{Ic.Lock()} Sign in to view balance</div>
            )}
            <div className="site-nav-theme">
              <div className="t-caption" id="theme-label">Appearance</div>
              <div className="theme-pick" role="group" aria-labelledby="theme-label">
                {[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([mode, name]) => (
                  <button key={mode} type="button" onClick={() => setTheme(mode)} aria-pressed={themeChoice === mode}>
                    {name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </aside>

      <main id="main-content" tabIndex={-1} className="site-main" data-view={view}>
        <View {...viewProps} />
      </main>
    </div>
  );
};
