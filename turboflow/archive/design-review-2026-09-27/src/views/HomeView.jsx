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
 * The home page, rebuilt on 25 Sep 2026 against DESIGN_RULES.md.
 *
 * It was five full-window slides, each a heading, a grey subtitle, a
 * paragraph, a button and something beside it (1.3, 2.2), and the only
 * product evidence was a video under an 86% veil (3.1). Now the hero shows the
 * video, the product comes first, and every section is built differently: the
 * steps of a run, a calculator you can use, and two short columns about help
 * from people.
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

const HomeView = ({ isSignedIn, onRequireAuth }) => (
  <div className="home">
    <section className="home-hero">
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
          {/* A link, signed in or not: the Workbench sends a signed-out
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
      {/* Real footage of the product, in full view (3.1). The poster paints
          on the first frame instead of a black box while the video loads. */}
      <figure className="home-hero-media">
        <video autoPlay muted loop playsInline poster="/hero-poster.jpg" preload="metadata"
          src="/hero-background.mp4" aria-label="The TurboFlow add-in in Fusion 360" />
        <figcaption className="t-caption">The TurboFlow add-in sending a car from Fusion 360.</figcaption>
      </figure>
    </section>

    <section className="home-sec home-cfd">
      <div className="home-sec-text">
        <h2 className="t-h1">Wind tunnel CFD</h2>
        <p className="t-body">
          Import a STEP, IGES or STL file in the Workbench, or send the car from
          Fusion 360 with the TurboFlow add-in. TurboFlow cuts the car out of a
          wind tunnel, finds the wheels and spins them at road speed, and writes
          the solver setup. You check it, see the price, and queue the run.
        </p>
        <div className="actions">
          <a href={PAGES.dash} className="btn-primary">Open the Workbench</a>
        </div>
      </div>
      <ol className="flow">
        {CFD_STEPS.map(({ t, b }) => (
          <li key={t}>
            <h3 className="t-h3">{t}</h3>
            <p className="t-body">{b}</p>
          </li>
        ))}
      </ol>
    </section>

    <section className="home-sec home-race">
      <div className="home-race-calc">
        <React.Suspense fallback={null}>
          <InlineRaceCalc isSignedIn={isSignedIn} onRequireAuth={onRequireAuth} />
        </React.Suspense>
      </div>
      <div className="home-sec-text">
        <h2 className="t-h1">Race time calculator</h2>
        <p className="t-body">
          Put in the drag from a run, your car's weight, its rolling friction
          and wheel inertia, and it predicts the time over the 20 metre track.
          See what a 0.01 N drag reduction is worth before you commit to a
          design direction.
        </p>
        <a href={PAGES.lapcalc} className="btn-quiet">Open the full calculator</a>
        <p className="t-caption">Free for sponsored teams. Other users pay 10 credits a run.</p>
      </div>
    </section>

    <section className="home-sec home-help">
      <h2 className="t-h1">Engineers who review your runs and fix your CAD</h2>
      <div className="home-help-cols">
        <div>
          <h3 className="t-h3">Mentorship</h3>
          <p className="t-body">
            Share your drag, lift and iteration history, and we review it before
            the first session. Then we map what to change next, what trade-offs to
            accept and how to spend your credits across the season, and stay with
            you through scrutineering. For F1 in Schools and STEM Racing teams.
          </p>
          <a href={PAGES.mentorship} className="btn-quiet">How mentorship works</a>
        </div>
        <div>
          <h3 className="t-h3">Modelling help</h3>
          <p className="t-body">
            Free for teams who buy CFD credits: we help clean and prepare geometry
            so it meshes. Spline and curve editing in Fusion 360, open shell and
            non-manifold edge repair, symmetry planes and domain sizing. Full
            builds from scratch are quoted separately.
          </p>
          <a href={PAGES.modelling} className="btn-quiet">What modelling help covers</a>
        </div>
      </div>
    </section>
  </div>
);

export { HomeView };
