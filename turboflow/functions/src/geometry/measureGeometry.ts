// The distance between two faces. Build spec 6.6.
//
// A thin front door onto the geometry service's /measure. It exists rather
// than the browser calling the service directly for the same reason every
// other call goes this way: the service trusts a Google identity token, and
// minting one in the browser would mean shipping a credential that can read
// any user's folder.
//
// It also does the one check the service cannot: that this geometry belongs
// to the caller, and which STEP path goes with the version they named. The
// service checks the path is under the caller's own prefix, but only this
// side knows whether the caller may open that geometry at all.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import { db } from "../lib/admin";
import { COL } from "../lib/config";
import { guard } from "../lib/guard";
import { docId } from "../groups/schemas";

export const measureGeometrySchema = z.object({
  geometry_id: docId,
  version: z.number().int().min(1).max(999),
  faces: z.array(z.number().int().min(0).max(1_000_000)).length(2),
});

function tessellateUrl(): string {
  const url = process.env.TESSELLATE_URL;
  if (!url) throw new HttpsError("failed-precondition", "The geometry service is not configured.");
  return url.replace(/\/+$/, "");
}

export const measureGeometry = onCall(async (request) => {
  const { uid, data } = await guard(request, "measureGeometry", measureGeometrySchema);

  const snap = await db.collection(COL.geometries).doc(data.geometry_id).get();
  if (!snap.exists) throw new HttpsError("not-found", "No such geometry.");

  // The owner, or someone the project was shared with. Read access is enough:
  // measuring changes nothing.
  if (snap.get("user_id") !== uid) {
    const groupId = snap.get("group_id");
    const group = groupId
      ? await db.collection(COL.groups).doc(groupId).get()
      : null;
    const shared = group?.get("shared_with") ?? {};
    if (!group?.exists || (group.get("user_id") !== uid && !shared[uid])) {
      throw new HttpsError("permission-denied", "That geometry is not yours.");
    }
  }

  const version = snap.get(`versions.${data.version}`);
  const stepPath = version?.step_path;
  if (!stepPath) {
    throw new HttpsError(
      "failed-precondition",
      "This geometry has no STEP for that version, so it cannot be measured.",
    );
  }

  const base = tessellateUrl();
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(base);
  const headers = await client.getRequestHeaders();

  const reply = await fetch(`${base}/measure`, {
    method: "POST",
    headers: { ...Object.fromEntries(new Headers(headers)), "Content-Type": "application/json" },
    body: JSON.stringify({
      step_path: stepPath,
      faces: data.faces,
      on_behalf_of: snap.get("user_id"),
    }),
  });

  const out = await reply.json().catch(() => ({} as Record<string, unknown>));
  if (!reply.ok) {
    throw new HttpsError(
      "failed-precondition",
      String((out as { error?: string }).error ?? "That could not be measured."),
    );
  }
  return out;
});
