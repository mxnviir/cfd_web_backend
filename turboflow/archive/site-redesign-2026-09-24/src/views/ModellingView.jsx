import React from "react";

// What the modelling help covers. The "what's included" check-mark list that
// followed repeated these four in shorter words (rule 1.7 bans check-mark
// lists as a selling device), so what it added is one sentence under them.
const SERVICES = [{
  t: 'Component guidance',
  b: 'Not sure how to model your front wing, halo, or diffuser? We walk you through geometry decisions, constraints, and design trade-offs before you even open Fusion 360.'
}, {
  t: 'Spline and curve editing',
  b: 'We edit your existing F3D files directly: smoothing splines, refitting transitions between component anchor points, and ensuring curves are solver-ready.'
}, {
  t: 'CAD prep and clean-up',
  b: 'STEP files with bad geometry, open shells, or non-manifold edges will cause mesh failures. We prepare and repair your CAD so it imports and meshes correctly.'
}, {
  t: 'Iterative design support',
  b: 'Working through multiple design cycles? We can help you set up parametric models in Fusion 360 so changing the angle of attack or chord length takes seconds, not hours.'
}];

const ModellingView = () => (
  <article className="page">
    <header className="page-head">
      <h1 className="t-h1">Modelling help for STEM Racing cars</h1>
      <p className="t-body">
        Struggling with a component or not sure where to start? Complimentary
        modelling support is available to all paying TurboFlow teams: spline
        edits, CAD prep, curve fitting, and component design help for F1 in
        Schools and STEM Racing cars.
      </p>
    </header>

    <dl className="facts">
      {SERVICES.map(({ t, b }) => (
        <React.Fragment key={t}>
          <dt>{t}</dt>
          <dd>{b}</dd>
        </React.Fragment>
      ))}
    </dl>

    <p className="t-body">
      It is free for existing TurboFlow customers and runs by email or Slack.
      It also covers setting up the F3D export for spline fitting and checking
      a model is ready to mesh.
    </p>
    <div className="actions page-actions">
      <a href="https://www.instagram.com/turboflow.cfd" target="_blank" rel="noopener noreferrer" className="btn-primary">
        Ask for modelling help on Instagram
      </a>
    </div>
  </article>
);

export { ModellingView };
