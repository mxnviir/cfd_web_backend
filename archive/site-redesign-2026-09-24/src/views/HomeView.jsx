import React from "react";
import { Ic } from "../lib/icons.js";
import { PAGES } from "../lib/pages";
/*
 * The race calculator, loaded on its own.
 *
 * It is the only thing on this page that touches Firebase, and importing it
 * here made the whole Firebase client a static dependency of the home page:
 * 115 kB gzipped, preloaded before first paint, for a widget most visitors
 * scroll past. The Shell was already careful to import Firebase dynamically,
 * and this quietly undid that.
 */
const InlineRaceCalc = React.lazy(() => import("../components/InlineRaceCalc.jsx")
  .then((m) => ({ default: m.InlineRaceCalc })));

/*
 * One slide per thing TurboFlow does. Each names what goes in and what comes
 * out, then shows it: the calculator itself, or the steps in order.
 *
 * Rewritten on 24 Sep 2026 against DESIGN_RULES.md. The CFD slide was three
 * cards with a coloured stripe down one side (1.1, 1.3); the mentorship slide
 * was big 01 02 03 numbers on a connecting line (1.3) with two pill badges
 * under an uppercase label (1.2, 2.2); the modelling slide was a check-mark
 * list (1.7). The steps are ordered lists now, and the modelling list is a
 * plain one. The buttons said "Get in Touch" and "Contact Us" and opened a
 * page about the programme, so they now say where they go (2.3).
 */
const SLIDES = [{
  id: 'racetime',
  title: 'Race time calculator',
  subtitle: 'Predict your track time from your car data.',
  description: 'Feed in your CFD results and car data, and our scripts calculate predicted track time from aero changes. Understand exactly how much a 0.01 N drag reduction is worth on the track before you commit to a design direction.',
  cta: 'Open the race time calculator',
  href: PAGES.lapcalc,
  note: 'Free for sponsored teams. It costs 10 credits per run for other users.',
}, {
  id: 'cfd',
  title: 'Wind tunnel CFD',
  subtitle: 'Import the car. TurboFlow builds the tunnel and the solver setup.',
  description: 'Import a STEP, IGES or STL file in the Workbench, or send the car from Fusion 360 with the TurboFlow add-in. TurboFlow cuts the car out of a wind tunnel, finds the wheels and spins them at road speed, and writes the solver setup. You check it, see the price, and queue the run.',
  steps: [{
    t: 'Import',
    b: 'STEP, IGES or STL up to 50 MB, or straight from Fusion 360. A car modelled as one half against its centreline is solved as a half and mirrored into the whole car.',
  }, {
    t: 'Set up',
    b: 'Quick setup builds the tunnel, labels every face and fills in the solver settings from your saved defaults. Each step can be opened and changed before you pay for the run.',
  }, {
    t: 'Results',
    b: 'Drag, lift and pitch for the whole car, convergence and force plots with CSV exports, the car coloured by pressure or air speed, and the full OpenFOAM case to open in ParaView.',
  }],
  cta: 'Open your groups',
  href: PAGES.dash,
}, {
  id: 'mentorship',
  title: 'Mentorship',
  subtitle: 'Guidance from engineers at every stage of your campaign.',
  description: 'Work directly with engineers who understand STEM racing. From interpreting your first CFD run to building a full aerodynamic development strategy for your car, we are with you throughout your campaign.',
  steps: [{
    t: 'Submit your results',
    b: 'Share your drag, lift, and iteration history. We review everything before our first session so no time is wasted.',
  }, {
    t: 'Strategy session',
    b: 'We map your development priorities: which parameters to target, what trade-offs to accept, and how to pace your simulation budget across the season.',
  }, {
    t: 'Ongoing support',
    b: 'We stay with you throughout the campaign: reviewing new runs, adjusting the plan, and helping you defend your design at scrutineering.',
  }],
  cta: 'How mentorship works',
  href: PAGES.mentorship,
  note: 'For F1 in Schools and STEM Racing teams only.',
}, {
  id: 'modelling',
  title: 'Modelling help',
  subtitle: 'Help getting your geometry ready to mesh.',
  description: 'Paying CFD users get modelling support at no extra cost. We help you build, clean, and prepare geometry that is actually simulation-ready.',
  included: ['Spline and curve editing in Fusion 360', 'Open shell and non-manifold edge repair', 'CAD prep and mesh-readiness checks', 'Symmetry planes and domain sizing', 'Parametric model setup for fast iteration', 'F3D export setup for spline fitting', 'Support by email or Instagram'],
  notIncluded: ['Full builds from scratch, which are quoted separately', 'Physical testing or wind tunnel work'],
  cta: 'What modelling help covers',
  href: PAGES.modelling,
  note: 'Free for paying CFD users. Contact us for standalone modelling work.',
}];

const Side = ({ slide, isSignedIn, onRequireAuth }) => {
  if (slide.id === 'racetime') {
    return (
      <React.Suspense fallback={null}>
        <InlineRaceCalc isSignedIn={isSignedIn} onRequireAuth={onRequireAuth} />
      </React.Suspense>
    );
  }
  if (slide.steps) {
    return (
      <ol className="flow">
        {slide.steps.map(({ t, b }) => (
          <li key={t}>
            <h3 className="t-h3">{t}</h3>
            <p className="t-body">{b}</p>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <div className="home-lists">
      <h3 className="t-h3">Included, free for CFD users</h3>
      <ul className="plain-list">{slide.included.map((x) => <li key={x}>{x}</li>)}</ul>
      <h3 className="t-h3">Not included</h3>
      <ul className="plain-list t-muted">{slide.notIncluded.map((x) => <li key={x}>{x}</li>)}</ul>
    </div>
  );
};

const HomeView = ({ isSignedIn, onRequireAuth }) => (
  <div className="home">
    <section className="home-hero">
      {/* The poster paints on the first frame of the page instead of leaving
          a black rectangle while the video arrives. The video itself is
          0.26 MB rather than 26 MB: it was 1080p60 with an audio track, played
          muted behind a dark veil, so almost none of that data was visible. */}
      <video className="home-hero-video" autoPlay muted loop playsInline
        poster="/hero-poster.jpg" preload="metadata" src="/hero-background.mp4" />
      <div className="home-hero-veil" />
      <div className="home-hero-text">
        <h1 className="t-display">Cloud CFD for STEM Racing cars</h1>
        <p className="t-body">
          Import your car from a STEP, IGES or STL file, or send it from Fusion
          360, and get drag, lift and a predicted race time back. Each run is
          a steady RANS solve with the k-omega SST turbulence model on
          SimScale's servers, so nothing installs on your computer and
          nothing ties it up overnight. A standard run is 150 credits, and
          sponsored teams pay a reduced rate.
        </p>
        <div className="actions">
          {/* A link, signed in or not: the dashboard sends a signed-out
              visitor to sign in and brings them back. */}
          <a href={PAGES.dash} className="btn-primary btn-lg">
            {!isSignedIn && Ic.Lock(13)}Start a simulation
          </a>
          <a href={PAGES.docs} className="btn-quiet">Read the setup guide</a>
        </div>
        {!isSignedIn && (
          <p className="t-caption home-hero-note">{Ic.Lock(11)} Free account required to run simulations.</p>
        )}
      </div>
      <div className="home-hero-fade" />
    </section>

    {SLIDES.map((slide) => (
      // In the stylesheet rather than inline, because what was wrong with it
      // can only be said in a media query: see .home-slide in styles.css.
      <section key={slide.id} className="home-slide">
        <div className="home-slide-text">
          <h2 className="t-h1">{slide.title}</h2>
          <p className="t-h3">{slide.subtitle}</p>
          <p className="t-body">{slide.description}</p>
          <div className="actions">
            <a href={slide.href} className="btn-primary">{slide.cta}</a>
            {slide.note && <p className="t-caption">{slide.note}</p>}
          </div>
        </div>
        <div className="home-slide-side">
          <Side slide={slide} isSignedIn={isSignedIn} onRequireAuth={onRequireAuth} />
        </div>
      </section>
    ))}
  </div>
);

export { HomeView };
