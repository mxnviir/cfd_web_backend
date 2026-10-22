import React from "react";
import { Ic } from "../lib/icons.js";
import { PAGES } from "../lib/pages";

// The one way into TurboFlow: Google.
//
// There was a second, on the test project only: an email and password form
// for the hi@hi.com account, added so the Workbench could be driven while
// testing. It was removed on 24 Sep 2026 with the email/password helpers in
// lib/firebase.js, and the Email/Password provider was switched off on
// turboflow-test. onUserCreate refuses any account that is not a Google one,
// so turning the provider back on would not bring password accounts back.
const AuthModal = ({ reason, onClose, onSignIn }) => {
  // Escape closes it, like every other dialog; there was no way out from the
  // keyboard except tabbing to the unlabelled close button.
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="auth-title"
        onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2 id="auth-title" className="t-h3 modal-title">
              <img src="/logo.png" alt="" width="20" height="20"
                onError={(e) => { e.target.style.display = "none"; }} />
              Sign in to TurboFlow
            </h2>
            <p className="t-small">
              {reason || "Create a free account to access simulations and purchase credits."}
            </p>
          </div>
          <button type="button" className="btn-quiet btn-icon btn-sm" aria-label="Close" onClick={onClose}>
            {Ic.X()}
          </button>
        </div>
        <div className="modal-body">
          <button type="button" className="btn-google btn-lg btn-block"
            onClick={() => { onSignIn(); onClose(); }}>
            {Ic.Google()} Continue with Google
          </button>
          <p className="t-caption">
            By signing in you agree to our <a href={PAGES.terms}>Terms of Service</a> and{" "}
            <a href={PAGES.privacy}>Privacy Policy</a>.
          </p>
        </div>
      </div>
    </div>
  );
};

/* -- Root ------------------------------------------------- */

export { AuthModal };
