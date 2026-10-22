// The ops router: every Firebase callable, as one HTTP endpoint.
//
//   POST /functions/v1/ops   {"op": "<callable name>", "payload": {...}}
//   -> 200 {"data": ...}  or  4xx/5xx {"error": {"code", "message"}}
//
// The names are the callables' names, so the frontend's port is a client
// swap. Every op is authenticated, rate limited and validated here, in one
// place, before its handler sees anything (functions/src/lib/guard.ts).
//
//   POST /functions/v1/ops/paypal-webhook   PayPal's settlement notices.
import { z } from "zod";
import { json, errorResponse, OpsError, CORS, callerOf, isInternal, enforceRateLimit, type Caller, type RateAction } from "../_shared/core.ts";
import { createGroupSchema, updateGroupSchema, groupIdSchema, copyGroupSchema, shareGroupSchema, unshareGroupSchema, docId } from "../_shared/logic/groupSchemas.ts";
import { refundJobSchema, createPayPalOrderSchema, capturePayPalOrderSchema } from "../_shared/logic/schema.ts";
import { createSimulationSchema, saveSimulationSchema } from "../_shared/logic/spec.ts";
import * as groups from "./groups.ts";
import * as geometry from "./geometry.ts";
import * as simulations from "./simulations.ts";
import * as runs from "./runs.ts";
import * as account from "./account.ts";
import * as paypal from "./paypal.ts";

export interface Ctx {
  caller: Caller;
  data: any;
  req: Request;
}

interface Op {
  run: (ctx: Ctx) => Promise<unknown>;
  schema: z.ZodTypeAny;
  rate?: RateAction;
  /** Refuse a session from a Fusion connection token: a script has no business here. */
  human?: boolean;
  /** No caller needed (the add-in has no session before this). */
  open?: boolean;
  /** Only from pg_cron or another of our functions. */
  internal?: boolean;
}

const runId = z.object({ run_id: docId });
const queueRunSchema = z.object({ simulation_id: docId, name: z.string().trim().min(1).max(200).optional() });

const OPS: Record<string, Op> = {
  ensureAccount: { run: account.ensureAccount, schema: z.object({}), rate: "ensureAccount", human: true },

  createGroup: { run: groups.createGroup, schema: createGroupSchema, rate: "createGroup" },
  updateGroup: { run: groups.updateGroup, schema: updateGroupSchema, rate: "updateGroup" },
  deleteGroup: { run: groups.deleteGroup, schema: groupIdSchema, rate: "deleteGroup", human: true },
  copyGroup: { run: groups.copyGroup, schema: copyGroupSchema, rate: "copyGroup", human: true },
  shareGroup: { run: groups.shareGroup, schema: shareGroupSchema, rate: "shareGroup", human: true },
  unshareGroup: { run: groups.unshareGroup, schema: unshareGroupSchema, rate: "shareGroup", human: true },

  createUploadIntent: { run: geometry.createUploadIntent, schema: geometry.createUploadIntentSchema, rate: "createUploadIntent" },
  createCarIntent: { run: geometry.createCarIntent, schema: geometry.createCarIntentSchema, rate: "createCarIntent" },
  ingestCar: { run: geometry.ingestCar, schema: geometry.ingestCarSchema, rate: "ingestCar" },
  failCarImport: { run: geometry.failCarImport, schema: z.object({}).passthrough(), rate: "failCarImport" },
  createArtifactIntent: { run: geometry.createArtifactIntent, schema: geometry.createArtifactIntentSchema, rate: "createArtifactIntent" },
  ingestPreparedDomain: { run: geometry.ingestPreparedDomain, schema: geometry.ingestPreparedDomainSchema, rate: "ingestPreparedDomain" },
  failDomainBuild: { run: geometry.failDomainBuild, schema: z.object({}).passthrough(), rate: "failDomainBuild" },

  createSimulation: { run: simulations.createSimulation, schema: createSimulationSchema, rate: "createSimulation" },
  saveSimulation: { run: simulations.saveSimulation, schema: saveSimulationSchema, rate: "saveSimulation" },
  revalidateSimulation: { run: simulations.revalidateSimulation, schema: z.object({ simulation_id: docId }), internal: true },

  queueRun: { run: runs.queueRun, schema: queueRunSchema, rate: "runJob" },
  cancelRun: { run: runs.cancelRun, schema: runId, rate: "refundJob" },
  refundJob: { run: runs.refundJob, schema: refundJobSchema, rate: "refundJob" },
  finishResults: { run: runs.finishResults, schema: runId, rate: "finishResults", human: true },

  createPayPalOrder: { run: paypal.createPayPalOrder, schema: createPayPalOrderSchema, rate: "createPayPalOrder", human: true },
  capturePayPalOrder: { run: paypal.capturePayPalOrder, schema: capturePayPalOrderSchema, rate: "capturePayPalOrder", human: true },

  createFusionToken: { run: account.createFusionToken, schema: z.object({ label: z.string().trim().max(60).optional() }), rate: "fusionToken" },
  revokeFusionToken: { run: account.revokeFusionToken, schema: z.object({ id: docId }), rate: "fusionToken", human: true },
  exchangeFusionToken: { run: account.exchangeFusionToken, schema: z.object({ token: z.string().max(200) }), open: true },
};

/** A pipeline-internal call has no person behind it. */
const SYSTEM: Caller = { uid: "", email: null, name: null, fusion: false, anonymous: false, google: false };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: { code: "invalid-argument", message: "POST only." } }, 405);
  if (new URL(req.url).pathname.endsWith("/paypal-webhook")) return paypal.paypalWebhook(req);

  try {
    const body = await req.json().catch(() => null);
    const op = OPS[String(body?.op ?? "")];
    if (!op) throw new OpsError("not-found", `No such operation: ${String(body?.op ?? "")}.`);

    let caller: Caller | null = SYSTEM;
    if (op.internal) {
      if (!(await isInternal(req))) throw new OpsError("permission-denied", "Not available.");
    } else if (!op.open) {
      caller = await callerOf(req);
      if (!caller) throw new OpsError("unauthenticated", "You must be signed in to do this.");
      if (op.human && caller.fusion) {
        throw new OpsError("permission-denied",
          "This can only be done while signed in to TurboFlow, not from a connection token.");
      }
      if (op.rate) await enforceRateLimit(caller.uid, op.rate);
    }

    // Only what the schema lists reaches the handler: a field cannot be
    // smuggled through by adding it to the payload.
    const parsed = op.schema.safeParse(body?.payload ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first?.path.length ? `${first.path.join(".")}: ` : "";
      throw new OpsError("invalid-argument", `${where}${first?.message ?? "Invalid request."}`);
    }
    return json({ data: await op.run({ caller: caller!, data: parsed.data, req }) });
  } catch (err) {
    return errorResponse(err);
  }
});
