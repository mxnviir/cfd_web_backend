import React from "react";

// What a sponsored team gets. This was a two-by-two grid of equal boxes, then
// a row of four big accent-coloured stat tiles, then a tinted call-to-action
// box: three of the patterns rules 1.2 and 1.3 ban, one after another. The
// stat tiles repeated the grid in numbers (80% off, free modelling, a 48 hour
// review) and those numbers are in the text below now. The fourth tile, "8
// team members", said nothing about what the 8 was, so it is not carried over.
const BENEFITS = [{
  title: 'Discounted credits',
  desc: 'Sponsored teams pay as little as $0.01 per credit: up to 80% off standard rates. The discount is permanent and locked in for the duration of your programme.'
}, {
  title: 'Priority support',
  desc: 'Direct access to our team for help with submissions, result interpretation, and troubleshooting. We are here throughout your entire campaign, not just when things go wrong.'
}, {
  title: 'Modelling help',
  desc: 'Struggling with your CAD geometry or not sure how to prepare your files? We will help you build, clean, and get your models simulation-ready, at no extra cost.'
}, {
  title: 'Engineering mentorship',
  desc: 'Get guidance from engineers on aerodynamic strategy, design iteration, and how to read and act on your CFD results effectively throughout the season.'
}];

const SponsorshipView = () => (
  <article className="page">
    <header className="page-head">
      <h1 className="t-h1">Sponsorship for STEM Racing teams</h1>
      <p className="t-body">
        F1 in Schools and STEM Racing teams get heavily discounted credits,
        priority support, and hands-on engineering help: permanently.
      </p>
    </header>

    <dl className="facts">
      {BENEFITS.map(({ title, desc }) => (
        <React.Fragment key={title}>
          <dt>{title}</dt>
          <dd>{desc}</dd>
        </React.Fragment>
      ))}
    </dl>

    <p className="t-body">
      Message us on Instagram and we will get back to you within 48 hours with
      a sponsorship package for your team.
    </p>
    <div className="actions page-actions">
      <a href="https://www.instagram.com/turboflow.cfd" target="_blank" rel="noopener noreferrer" className="btn-primary">
        Apply for sponsorship on Instagram
      </a>
    </div>
  </article>
);

export { SponsorshipView };
