import React from "react";

// The run, in the order it happens. Each step names what goes in and what
// comes out; the numbers are an ordered list's, not decoration (rule 1.3 bans
// the big faded 01 02 03 this used to be).
const FLOW = [{
  t: 'Get the car in',
  b: 'Import a STEP, IGES or STL file of up to 50 MB in the Workbench, or send it from Fusion 360 with the add-in above. The unit is read from the file; check the length the Workbench shows against the real car.'
}, {
  t: 'Build the wind tunnel',
  b: 'Quick setup cuts the car out of a wind tunnel and finds the wheels. The default tunnel is half width with a symmetry plane, which solves a quarter of the cells for the same answer. A car modelled as a half is mirrored. If the cut fails, the Workbench says why.'
}, {
  t: 'Check the setup',
  b: 'Every face is labelled: inlet, outlet, road, tunnel walls, car and wheels. The road moves with the air and ticked wheels spin at road speed. Mesh fineness and the iteration count set the price, which is shown before you queue.'
}, {
  t: 'Solve',
  b: 'The run goes to SimScale: steady RANS with the k-omega SST turbulence model. Progress and the convergence plots update while it runs. A run at the default settings takes 20 to 30 minutes.'
}, {
  t: 'Read the results',
  b: 'Drag, lift and pitch for the whole car (a half model is doubled), convergence and force plots with CSV downloads, the car coloured by pressure or air speed, and the full OpenFOAM case to open in ParaView.'
}, {
  t: 'Change the car and run it again',
  b: 'Import the next version into the same group. Every simulation in the group keeps its own drag, so versions sit side by side, and each run is compared with the one before it.'
}];

const DocsView = () => (
  <article className="page">
    <header className="page-head">
      <h1 className="t-h1">Set up your first simulation</h1>
      <p className="t-body">
        Install the Fusion 360 add-in, prepare your geometry, and submit a run.
        Each step below names what it needs and what it produces.
      </p>
    </header>

    <section className="page-section">
      <h2 className="t-h2">The Fusion 360 add-in</h2>
      <p className="t-body">
        A script for Fusion 360 that prepares the wind-tunnel geometry from the
        car you have open and uploads it to TurboFlow as a run. It signs in
        with a connection token, which you create on the Simulations page and
        paste into the add-in once.
      </p>
      <div className="actions page-actions">
        {/* Built with the site by scripts/build-addin.mjs, for this site's
            project. It was a production download of an older add-in that
            could not use the connection tokens the Simulations page hands
            out. */}
        <a href="/downloads/TurboFlow_CFD.zip" className="btn-primary">Download the add-in (ZIP)</a>
        <a href="https://youtu.be/hKHx4sC5Mw4" target="_blank" rel="noopener noreferrer" className="btn-quiet">
          Watch the install video on YouTube
        </a>
      </div>
    </section>

    <section className="page-section">
      <h2 className="t-h2">From a CAD file to drag and lift</h2>
      <ol className="flow">
        {FLOW.map(({ t, b }) => (
          <li key={t}>
            <h3 className="t-h3">{t}</h3>
            <p className="t-body">{b}</p>
          </li>
        ))}
      </ol>
    </section>
  </article>
);

export { DocsView };
