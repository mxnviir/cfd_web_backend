import React from "react";
import { Ic } from "../lib/icons.js";
import { PAGES } from "../lib/pages";
/*
 * The race calculator, loaded on its own.
 *
 * It is the only thing on this page that touches Firebase, and importing it
 * here made the whole Firebase client a static dependency of the home page:
 * 115 kB gzipped, preloaded before first paint, for a widget most visitors
 * scroll past.
 */
const InlineRaceCalc = React.lazy(() => import("../components/InlineRaceCalc.jsx")
  .then((m) => ({ default: m.InlineRaceCalc })));

/*
 * The home page, back to the layout of turboflow.cloud on 27 Sep 2026: the
 * Fusion 360 footage behind the hero, then the race time calculator, CFD,
 * mentorship and modelling, each as words on the left and the thing itself on
 * the right. What DESIGN_RULES.md bans was left out of the copy: the "01" to
 * "05" numbers, arrow glyphs, uppercase labels, a colour per section, pills
 * and check-mark lists. The copy is turboflow.cloud's, corrected to what the
 * product does today (one run per submission, STEP, IGES or STL).
 */
const CFD_STEPS = [{
  t: 'Import',
  b: 'STEP, IGES or STL up to 50 MB, or straight from Fusion 360. A car modelled as one half against its centreline is solved as a half and mirrored into the whole car.',
}, {
  t: 'Set up',
  b: 'Quick setup builds the tunnel, labels every face and fills in the solver settings from your saved defaults. Each step can be opened and changed before you pay for the run.',
}, {
  t: 'Results',
  b: 'Drag, lift and pitch for the whole car, convergence and force plots with CSV exports, the car coloured by pressure or air speed, and the full OpenFOAM case to open in ParaView.',
}];

const MENTOR_STEPS = [{
  t: 'Submit your results',
  b: 'Share your drag, lift and iteration history. We review everything before the first session so no time is wasted.',
}, {
  t: 'Strategy session',
  b: 'We map your development priorities: which parameters to target, what trade-offs to accept, and how to pace your credits across the season.',
}, {
  t: 'Ongoing support',
  b: 'We stay with you through the campaign: reviewing new runs, adjusting the plan, and helping you defend your design at scrutineering.',
}];

const MODELLING_INCLUDED = [
  'Spline and curve editing in Fusion 360',
  'Open shell and non-manifold edge repair',
  'CAD prep and mesh-readiness checks',
  'Symmetry planes and domain sizing',
  'Parametric model setup for quick design changes',
  'F3D export setup for spline fitting',
  'Help by email or Slack',
];
const MODELLING_EXCLUDED = [
  'Full builds from scratch, quoted separately',
  'Physical testing or wind tunnel work',
];

const HomeView = ({ isSignedIn, onRequireAuth }) => (
  <div className="home">
    <section className="home-hero">
      {/* Real footage of the add-in. The poster paints on the first frame
          instead of a black box while the video loads. */}
      <video className="home-hero-video" autoPlay muted loop playsInline poster="/hero-poster.jpg"
        preload="metadata" src="/hero-background.mp4" aria-hidden="true" />
      <div className="home-hero-text">
        <h1 className="t-display">Cloud CFD for STEM Racing cars</h1>
        <p className="home-hero-lead">
          For F1 in Schools and STEM Racing teams. Send your car from Fusion 360,
          or import a STEP, IGES or STL file, and get drag, lift and a predicted
          race time back. The solve runs on SimScale's servers, so nothing
          installs on your computer.
        </p>
        <div className="actions">
          {/* A link, signed in or not: the Workbench sends a signed-out
              visitor to sign in and brings them back. */}
          <a href={PAGES.dash} className="btn-primary btn-lg">
            {!isSignedIn && Ic.Lock(13)}Run a simulation
          </a>
          <a href={PAGES.docs} className="btn-quiet btn-lg">Read the setup guide</a>
        </div>
        {!isSignedIn && (
          <p className="t-caption home-hero-note">{Ic.Lock(11)} Free account required to run simulations.</p>
        )}
      </div>
    </section>

    <section className="home-sec">
      <div className="home-sec-text">
        <h2 className="t-h1">Race time calculator</h2>
        <p className="t-body">
          Predict your time over the 20 metre track from your car data. Put in
          the drag from a CFD run, the car's weight, its rolling friction and
          wheel inertia, and see what a 0.01 N drag reduction is worth before
          you commit to a design direction.
        </p>
        <a href={PAGES.lapcalc} className="btn-secondary">Open the full calculator</a>
        <p className="t-caption">Free for sponsored teams. Other users pay 10 credits a run.</p>
      </div>
      <div className="home-sec-body home-race-calc">
        <React.Suspense fallback={null}>
          <InlineRaceCalc isSignedIn={isSignedIn} onRequireAuth={onRequireAuth} />
        </React.Suspense>
      </div>
    </section>

    <section className="home-sec">
      <div className="home-sec-text">
        <h2 className="t-h1">Wind tunnel CFD</h2>
        <p className="t-body">
          Upload your geometry and TurboFlow sets up the run. It cuts the car
          out of a wind tunnel, finds the wheels and spins them at road speed,
          and writes the solver settings. You check the setup, see the price,
          and queue the run.
        </p>
        <a href={PAGES.dash} className="btn-primary">
          {!isSignedIn && Ic.Lock(13)}Open the Workbench
        </a>
      </div>
      <ol className="home-sec-body flow">
        {CFD_STEPS.map(({ t, b }) => (
          <li key={t}>
            <h3 className="t-h3">{t}</h3>
            <p className="t-body">{b}</p>
          </li>
        ))}
      </ol>
    </section>

    <section className="home-sec">
      <div className="home-sec-text">
        <h2 className="t-h1">Mentorship</h2>
        <p className="t-body">
          Work directly with engineers who understand STEM racing. From reading
          your first CFD run to planning your car's aero development, we stay
          with you throughout your campaign.
        </p>
        <a href={PAGES.mentorship} className="btn-secondary">How mentorship works</a>
        <p className="t-caption">For F1 in Schools and STEM Racing teams only.</p>
      </div>
      <ol className="home-sec-body home-timeline">
        {MENTOR_STEPS.map(({ t, b }) => (
          <li key={t}>
            <h3 className="t-h3">{t}</h3>
            <p className="t-body">{b}</p>
          </li>
        ))}
      </ol>
    </section>

    <section className="home-sec">
      <div className="home-sec-text">
        <h2 className="t-h1">Modelling help</h2>
        <p className="t-body">
          Teams who buy CFD credits get modelling support at no extra cost. We
          help you build, clean and prepare geometry that is ready to simulate.
        </p>
        <a href={PAGES.modelling} className="btn-secondary">What modelling help covers</a>
        <p className="t-caption">Free for paying CFD users. Standalone modelling work is quoted separately.</p>
      </div>
      <div className="home-sec-body home-panel">
        <h3 className="t-label">Included, free for CFD users</h3>
        <ul className="plain-list">
          {MODELLING_INCLUDED.map((i) => <li key={i}>{i}</li>)}
        </ul>
        <h3 className="t-label">Not included</h3>
        <ul className="plain-list t-muted">
          {MODELLING_EXCLUDED.map((i) => <li key={i}>{i}</li>)}
        </ul>
      </div>
    </section>
  </div>
);

export { HomeView };
