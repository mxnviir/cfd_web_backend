// Input shapes for every callable, as zod schemas.
//
// The old backend hand-checked a couple of fields per function and trusted the
// rest. That is how a client-supplied `cost` ended up deciding a refund. Here a
// callable receives only what its schema lists: anything else the client sends
// is dropped before the handler sees it, so a field cannot be smuggled through
// by adding it to the payload.
//
// Note what is absent on purpose: no schema accepts `cost`, `credits` as a
// balance, `status` beyond the two a client may set, or `user_id`. Those are
// server-decided, always.
import { z } from "zod";
import { LIMITS } from "./pricing";

const shortText = z.string().trim().min(1).max(200);
const optionalText = z.string().trim().max(200).nullish();

/** A Firestore document id. Rejects path traversal and empty segments. */
export const docId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "must be a document id");

export const submitJobSchema = z.object({
  simulation_id: docId.nullish(),
  group_id: docId.nullish(),
  geometry_id: docId.nullish(),
  file_name: optionalText,
  team_name: optionalText,
  iteration_count: z.number().int().min(LIMITS.iterations.min).max(LIMITS.iterations.max).optional(),
  refine_level: z.number().int().min(LIMITS.refineLevel.min).max(LIMITS.refineLevel.max).optional(),
  inlet_velocity: z.number().min(LIMITS.inletVelocity.min).max(LIMITS.inletVelocity.max).optional(),
  debug_mesh: z.boolean().optional(),
  // The full setup document is stored on the job as a snapshot. It is opaque to
  // the backend — cfd-setup.js owns its shape — so it is size-capped rather than
  // field-checked.
  setup: z.record(z.unknown()).optional(),
});

export const refundJobSchema = z.object({
  job_id: docId,
});

export const createPayPalOrderSchema = z.discriminatedUnion("product", [
  z.object({
    product: z.literal("credits"),
    credits: z.number().int().positive(),
  }),
  z.object({
    product: z.literal("unlimited"),
    months: z.number().int().positive(),
  }),
]);

export const capturePayPalOrderSchema = z.object({
  order_id: z.string().trim().min(1).max(64),
});

/** The CAD formats the geometry service can read. Build spec 14.2. */
export const RAW_EXTENSIONS = ["step", "stp", "iges", "igs", "stl"] as const;

/**
 * What the file says its lengths are in.
 *
 * STEP carries its own unit and IGES usually does; STL never does, which is
 * why this is asked at upload rather than guessed. A car uploaded as inches
 * and read as millimetres is a car twenty-five times too small, and every
 * number after that is wrong without anything looking wrong.
 */
export const INPUT_UNITS = ["m", "cm", "mm", "in", "ft", "yd"] as const;

export const createUploadIntentSchema = z.object({
  /** Omit to mint a new geometry; supply it to attach the second file to one. */
  geometry_id: docId.nullish(),
  group_id: docId.nullish(),
  name: shortText,
  size_bytes: z.number().int().positive().max(200 * 1024 * 1024),
  /** step and labels are the Fusion path; raw is the Workbench upload. */
  kind: z.enum(["step", "labels", "raw"]),
  ext: z.enum(RAW_EXTENSIONS).optional(),
  input_unit: z.enum(INPUT_UNITS).optional(),
  import_options: z.object({
    facet_split: z.boolean().optional(),
    sewing: z.boolean().optional(),
    improve: z.boolean().optional(),
  }).optional(),
});

/** Guard against a setup blob large enough to blow the 1 MiB document limit. */
export function assertSetupSize(setup: unknown): void {
  if (setup === undefined) return;
  const bytes = Buffer.byteLength(JSON.stringify(setup), "utf8");
  if (bytes > 256 * 1024) {
    throw new Error("Setup document is too large (limit 256 KB).");
  }
}
