// Which project this code is running in, and what that is allowed to do.
//
// The old backend had the project id typed in as a string literal. A deploy to
// any other project therefore still dispatched Cloud Run jobs into production
// and could still reach live PayPal. Everything environment-specific is
// resolved here instead, from the runtime, so that class of mistake needs a
// deliberate edit rather than an oversight.
import { defineSecret } from "firebase-functions/params";

/** The one project id that is allowed to touch real money and real workers. */
export const PROD_PROJECT_ID = "turboflow-7b3ca";

/** Set by the Functions runtime and by the emulator. Never hardcoded. */
export function projectId(): string {
  const id = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!id) throw new Error("GCLOUD_PROJECT is not set.");
  return id;
}

export const isProd = (): boolean => projectId() === PROD_PROJECT_ID;

export const REGION = "us-central1";
// Which Cloud Run job solves a run. Production already has a `simscale-job`:
// the original worker, which the original app (and a rollback to it) needs
// untouched. So production names its new worker in functions/.env.<project>
// (WORKER_JOB=simscale-worker) and the two stand side by side.
export const CLOUD_RUN_JOB = process.env.WORKER_JOB || "simscale-job";

// Secrets live in Secret Manager, not in a .env file sitting next to the code.
// Set them with:  firebase functions:secrets:set PAYPAL_SECRET
export const PAYPAL_CLIENT_ID = defineSecret("PAYPAL_CLIENT_ID");
export const PAYPAL_SECRET = defineSecret("PAYPAL_SECRET");
export const PAYPAL_WEBHOOK_ID = defineSecret("PAYPAL_WEBHOOK_ID");
export const DISCORD_WEBHOOK_URL = defineSecret("DISCORD_WEBHOOK_URL");

/**
 * Read a secret, treating a placeholder as "not set".
 *
 * defineSecret requires the secret to exist in Secret Manager before the
 * function will deploy, so a project that has no PayPal credentials yet still
 * needs the four entries present. They are created holding "unset", and this
 * turns that back into an empty string — so the code reports "PayPal is not
 * configured" rather than sending the literal word "unset" to PayPal and
 * reporting an authentication failure nobody can act on.
 */
const PLACEHOLDERS = new Set(["", "unset", "UNSET", "REPLACE_ME", "changeme"]);

export function secretValue(secret: { value(): string }): string {
  let raw = "";
  try {
    raw = secret.value() ?? "";
  } catch {
    return "";
  }
  return PLACEHOLDERS.has(raw.trim()) ? "" : raw;
}

/**
 * PayPal's API base.
 *
 * Only the production project can ever reach live PayPal. On any other project
 * this returns sandbox no matter what PAYPAL_ENV says, so a test deploy cannot
 * charge a real card even if it is handed live credentials by mistake.
 */
export function paypalBase(): string {
  const live = isProd() && (process.env.PAYPAL_ENV || "").toLowerCase() === "live";
  return live ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

/** Collection names, in one place so a typo is a compile error rather than a silent empty read. */
export const COL = {
  users: "users",
  jobs: "jobs",
  /*
   * Groups, not projects, and there is no folders collection any more.
   *
   * The old shape was SimScale's: a project held geometries and simulations,
   * and folders held projects. Two levels of container for a product where a
   * simulation is one car in one tunnel, so a "project" was nearly always one
   * simulation wearing a folder. A group holds as many simulations as you
   * like and there is nothing above it.
   */
  groups: "groups",
  geometries: "geometries",
  simulations: "simulations",
  runs: "runs",
  config: "config",
  paypalOrders: "paypal_orders",
  rate: "rate",
  transactions: "transactions", // subcollection of users/{uid}
} as const;
