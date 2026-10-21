// Bridges the Fusion add-in's camelCase job documents to the snake_case schema.
//
// Firestore is snake_case now: the Workbench, cfd-setup.js and both Python
// services already speak it, and it is the larger body of code. The Fusion
// add-in writes camelCase (inletVelocity, stepPath, refineLevel, …) and copies
// of it are installed on users' machines, so it cannot simply be switched.
//
// Rather than teach every reader both spellings — which is exactly how a drag
// number ends up silently mislabelled — the conversion happens once, when a job
// document is first seen, and everything downstream reads one spelling.
//
// Blob fields are left alone. `setup`, `plots` and `bbox` are camelCase inside
// by design (cfd-setup.js owns them), and rewriting their inner keys would
// break the panels that read them.
const BLOB_KEYS = new Set(["setup", "setup_snapshot", "plots", "bbox", "results_fields", "lap_calc_defaults"]);

/** Field names the add-in uses that do not convert mechanically. */
const EXPLICIT: Record<string, string> = {
  jobId: "job_id",
  userId: "user_id",
  paraviewUrl: "paraview_url",
  drag_N: "drag_n",
  lift_N: "lift_n",
  bucket: "bucket",
};

const toSnake = (k: string): string =>
  k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();

/**
 * Returns only the keys that need rewriting, as {new_key: value} plus the old
 * keys mapped to a delete sentinel supplied by the caller.
 *
 * Returning a patch rather than a whole document matters: the worker writes to
 * the same document concurrently, and replacing it wholesale would drop a status
 * the worker had just set.
 */
export function snakeCasePatch(
  data: Record<string, unknown>,
  deleteSentinel: unknown,
): Record<string, unknown> {
  // Object.create(null), and hasOwn rather than a lookup.
  //
  // `data` is a job document, and firestore.rules lets a client create one with
  // whatever extra fields it likes - the rules check ownership, the status and
  // the paths, not the key set. Two of JavaScript's inherited names then bite:
  //
  //   a field called `constructor` makes `EXPLICIT[key]` return the Object
  //   function rather than undefined, so `mapped` becomes a function, and the
  //   patch ends up with a key stringified from it. Firestore refuses that
  //   field name and the whole charge-and-dispatch handler throws.
  //
  //   a field called `__proto__` on a plain `patch` object assigns the
  //   prototype instead of a property.
  //
  // A null-prototype object has neither name to inherit, and hasOwn only sees
  // what EXPLICIT actually declares.
  const patch: Record<string, unknown> = Object.create(null);

  for (const [key, value] of Object.entries(data)) {
    if (BLOB_KEYS.has(key)) continue;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const mapped = (Object.hasOwn(EXPLICIT, key) ? EXPLICIT[key] : undefined) ?? toSnake(key);
    if (mapped === key) continue;

    // If the snake_case spelling is already present, the document has been
    // through here before (or was written by a new client). Drop the stale
    // camelCase key rather than overwrite the good value with it.
    if (!(mapped in data)) patch[mapped] = value;
    patch[key] = deleteSentinel;
  }
  return patch;
}

/** A read-time view of a job document that tolerates either spelling. */
export function readField<T>(data: Record<string, unknown>, snakeKey: string): T | undefined {
  if (snakeKey in data) return data[snakeKey] as T;
  const camel = snakeKey.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return data[camel] as T | undefined;
}
