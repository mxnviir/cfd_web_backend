// Shapes of the documents this backend reads and writes.
//
// Firestore is schemaless, so these are a description rather than a guarantee —
// anything that arrives from a client is validated with zod before it is
// trusted. What they buy is that a field rename becomes a compile error in
// every file that reads it, instead of an undefined at runtime.
import type { Timestamp } from "firebase-admin/firestore";

/** Statuses a job can hold. Written by this backend and by the SimScale worker. */
export const JOB_STATUS = [
  "draft",                // created by the Workbench; geometry not uploaded yet. Never charged.
  "pending",              // ready to run. Entering this state is what charges the account.
  "downloading",          // worker has picked it up
  "uploading_geometry",
  "processing",
  "creating_simulation",
  "checking",             // SimScale's own validation, before any meshing
  "meshing",
  "running",
  "downloading_results",
  "complete",
  "failed",
  "cancelling",           // user asked to stop; worker notices and winds down
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUS)[number];

/** Statuses at which no compute has been spent yet, so a refund is the full amount. */
export const REFUNDABLE_STATUSES: readonly JobStatus[] = [
  // "checking" is in here on purpose. SimScale's own check runs before any
  // meshing, so a setup it refuses has consumed no solver time and the whole
  // charge goes back. That is the case the reversal rule exists for.
  "draft", "pending", "downloading", "uploading_geometry", "processing", "checking",
];

/** Statuses the worker owns. The account keeps its charge once these are reached. */
export const TERMINAL_STATUSES: readonly JobStatus[] = [
  "complete", "failed", "cancelled",
];

export interface UserDoc {
  email?: string;
  name?: string | null;
  team_name?: string | null;
  credits?: number;
  sponsored?: boolean;
  sponsor_rate?: number;
  usd_per_credit?: number;
  unlimited_usd?: number;
  unlimited_until?: Timestamp | null;
  unlimited_started_at?: Timestamp | null;
  created_at?: Timestamp;
  last_seen?: Timestamp;
}

export interface JobDoc {
  user_id: string;
  status: JobStatus;
  source: "fusion" | "web";
  cost?: number;
  file_name?: string | null;
  team_name?: string | null;
  step_path?: string | null;
  label_path?: string | null;
  iteration_count?: number;
  refine_level?: number;
  inlet_velocity?: number;
  debug_mesh?: boolean;
  mesh_cells_m?: number;
  group_id?: string | null;
  simulation_ref?: string | null;
  setup_snapshot?: Record<string, unknown> | null;
  drag_n?: number | null;
  lift_n?: number | null;
  error?: string | null;
  created_at?: Timestamp;
}

export type TransactionType =
  | "simulation_charge"
  | "simulation_charge_reversal"
  | "refund"
  | "purchase"
  | "unlimited_pass"
  | "signup_bonus";
