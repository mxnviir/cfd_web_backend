// The layout the four policy pages share: a title, the date the text last
// changed, and the clauses. Written once so the four cannot drift apart, which
// they had: the same markup was pasted into each file with different margins.
import React from "react";

export function LegalPage({ title, updated, clauses, children }) {
  return (
    <article className="page">
      <header className="page-head">
        <h1 className="t-h1">{title}</h1>
        <p className="t-caption">Last updated: {updated}</p>
      </header>
      {children}
      {clauses.map(({ t, b }) => (
        <section key={t} className="clause">
          <h2 className="t-h3">{t}</h2>
          <p className="t-body">{b}</p>
        </section>
      ))}
    </article>
  );
}
