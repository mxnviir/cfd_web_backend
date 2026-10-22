import React from "react";

// What a mentor helps with. A list of terms rather than a two-by-two grid of
// equal boxes (rule 1.2, bento tiles), with the contact line under it instead
// of a tinted "get in touch" box (rule 1.3).
const TOPICS = [{
  title: 'Engineering guidance',
  desc: 'Work with engineers who can help you interpret CFD results, understand performance trade-offs, and make confident design decisions at every stage of your season.'
}, {
  title: 'Aero development strategy',
  desc: 'Learn how to prioritise your simulation budget, which parameters to target first, and how to build a structured iteration plan that actually improves your car.'
}, {
  title: 'Competition preparation',
  desc: 'Tailored support for F1 in Schools and STEM Racing events. We help you present your aero work clearly and defend your design decisions under scrutiny.'
}, {
  title: 'Reading your results',
  desc: 'Not sure what your drag and lift numbers mean in practice? We explain what they say about the car and which change to try next.'
}];

const MentorshipView = () => (
  <article className="page">
    <header className="page-head">
      <h1 className="t-h1">Mentorship for STEM Racing teams</h1>
      <p className="t-body">
        Direct access to engineers who understand STEM racing. From
        interpreting your first CFD run to building a full aerodynamic
        development strategy, we are with you throughout your campaign.
      </p>
    </header>

    <dl className="facts">
      {TOPICS.map(({ title, desc }) => (
        <React.Fragment key={title}>
          <dt>{title}</dt>
          <dd>{desc}</dd>
        </React.Fragment>
      ))}
    </dl>

    <p className="t-body">
      An F1 in Schools or STEM Racing team? Message us on Instagram and we will
      get back to you about how we can support your team.
    </p>
    <div className="actions page-actions">
      <a href="https://www.instagram.com/turboflow.cfd" target="_blank" rel="noopener noreferrer" className="btn-primary">
        Message us on Instagram
      </a>
    </div>
  </article>
);

export { MentorshipView };
