// Shown for a URL that does not exist.
//
// The old site could not have this page. A hosting rewrite sent every unmatched
// path to index.html, so a typo returned the home page with a 200 and looked
// like it had worked.
import React from "react";
import { PAGES } from "../lib/pages";

export const NotFoundView = () => (
  <article className="page">
    <header className="page-head">
      <h1 className="t-h1">That page does not exist</h1>
      <p className="t-body">
        The link may be out of date, or the address may have a typo in it.
      </p>
    </header>
    <div className="actions">
      <a href={PAGES.home} className="btn-primary">Go to the home page</a>
      <a href={PAGES.simulations} className="btn-quiet">Your simulations</a>
    </div>
  </article>
);
