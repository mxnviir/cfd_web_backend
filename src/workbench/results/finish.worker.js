// Converts a finished run's case in a Web Worker, so a case of hundreds of
// MB never blocks the page. Reads the case by HTTP Range requests against a
// signed URL; see openfoam.js for what it reads and why.
import { convertCase } from "./openfoam.js";

// The size comes from the caller: a signed URL's response does not expose
// Content-Range to scripts, so it cannot be learnt from a probe.
self.onmessage = async ({ data: { url, size } }) => {
  try {
    const read = async (start, end) => {
      const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
      if (resp.status !== 206 && resp.status !== 200) throw new Error(`the results could not be read (${resp.status})`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      // A server that ignores Range sends the whole file; take the slice.
      return resp.status === 200 ? buf.slice(start, end) : buf;
    };
    if (!size) throw new Error("the results package is empty");
    const { glb, surface } = await convertCase(read, size, (fraction, text) => self.postMessage({ progress: { fraction, text } }));
    const fields = Object.fromEntries(Object.entries(surface.fields)
      .map(([name, f]) => [name, { values: f.values.buffer, min: f.min, max: f.max }]));
    self.postMessage({
      done: { glb: glb.buffer, fields, vertexCount: surface.vertexCount, triangleCount: surface.triangleCount },
    }, [glb.buffer, ...Object.values(fields).map((f) => f.values)]);
  } catch (err) {
    self.postMessage({ error: err?.message || String(err) });
  }
};
