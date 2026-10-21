// Starts the SimScale worker for one job.
//
// Split out from the charging handler so the two failures stay tellable apart:
// "we could not take the credits" and "we took the credits but could not start
// the work" need different responses, and the second one has to give the
// credits back.
import { GoogleAuth } from "google-auth-library";
import { REGION, CLOUD_RUN_JOB, projectId } from "../lib/config";

export class DispatchError extends Error {}

/**
 * Start the worker for one job.
 *
 * `extra` carries SPEC_MODE and RUN_ID for a Workbench run. The worker has
 * two paths: the old one builds the SimScale model from four columns on the
 * job, the new one sends the spec the Workbench saved. Which path it takes
 * has to be decided here rather than inside the worker, because the Fusion
 * add-in still writes jobs with no spec at all and those must keep working.
 */
export async function dispatchWorker(
  jobId: string,
  extra: Record<string, string> = {},
): Promise<void> {
  const project = projectId();

  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token?.token) throw new DispatchError("Could not obtain a Google access token.");

  const url = `https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1`
    + `/namespaces/${project}/jobs/${CLOUD_RUN_JOB}:run`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      overrides: {
        containerOverrides: [{
          env: [
            { name: "JOB_ID", value: jobId },
            ...Object.entries(extra).map(([name, value]) => ({ name, value })),
          ],
        }],
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new DispatchError(`Cloud Run rejected the job: ${resp.status} ${body.slice(0, 300)}`);
  }
}
