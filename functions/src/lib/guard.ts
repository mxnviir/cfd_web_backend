// The checks every callable runs before it does anything.
//
// The old backend repeated `if (!request.auth) throw ...` in each function and
// had no rate limiting and no input validation at all — which is how a job could
// be created carrying its own price. Here the three checks are one call, so a
// new function cannot quietly skip one.
import { HttpsError } from "firebase-functions/v2/https";
import type { CallableRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import { enforceRateLimit, RATE } from "./ratelimit";

export interface Caller<T> {
  uid: string;
  email: string | undefined;
  data: T;
}

export interface GuardOptions {
  /**
   * Refuse a session created from a Fusion connection token.
   *
   * Those sessions belong to a desktop script, and a script has no business
   * spending money or changing an account. Marking the endpoints that only a
   * person should reach limits what a leaked connection token is worth.
   */
  humanOnly?: boolean;
}

/**
 * Authenticate, rate limit, and validate the payload in one step.
 *
 * Validation failures are reported as invalid-argument with the field path, so
 * a client gets a usable message instead of "internal".
 */
export async function guard<S extends z.ZodTypeAny>(
  request: CallableRequest<unknown>,
  action: keyof typeof RATE,
  schema: S,
  options: GuardOptions = {},
): Promise<Caller<z.infer<S>>> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in to do this.");
  }
  const uid = request.auth.uid;

  if (options.humanOnly && request.auth.token?.fusion === true) {
    throw new HttpsError(
      "permission-denied",
      "This can only be done while signed in to TurboFlow, not from a connection token.",
    );
  }

  await enforceRateLimit(uid, action);

  const parsed = schema.safeParse(request.data ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw new HttpsError("invalid-argument", `${where}${first?.message ?? "Invalid request."}`);
  }

  const token = request.auth.token as { email?: string };
  return {
    uid,
    email: token.email,
    data: parsed.data,
  };
}
