// The TurboFlow backend.
//
// Every function is defined in its own file; this one only decides what is
// deployed and under what name. The names match what the old backend exported
// where the contract is unchanged, so an old client keeps working.
import { setGlobalOptions } from "firebase-functions/v2";
import { REGION } from "./lib/config";

setGlobalOptions({
  region: REGION,
  maxInstances: 10,
  // A callable that has not answered in a minute has failed; holding the
  // instance longer only costs money.
  timeoutSeconds: 60,
});

// Jobs
export { submitJob, startJob } from "./jobs/submitJob";
export { refundJob } from "./jobs/refundJob";
export { onJobPending } from "./jobs/onJobPending";

// Projects and folders
export {
  createGroup, updateGroup, deleteGroup, copyGroup,
  shareGroup, unshareGroup,
} from "./groups";

// Geometry intake
export { createUploadIntent } from "./geometry/createUploadIntent";
export {
  createCarIntent, ingestCar, failCarImport,
} from "./geometry/inspectedCar";
export {
  createArtifactIntent, ingestPreparedDomain, failDomainBuild,
} from "./geometry/preparedDomain";
export {
  createSimulation, saveSimulation, onSimulationWritten,
} from "./simulations";
export { queueRun } from "./jobs/queueRun";
export { onJobFinished } from "./jobs/onJobFinished";
export { cancelRun } from "./jobs/cancelRun";

// Money
export { createPayPalOrder } from "./paypal/createOrder";
export { capturePayPalOrder } from "./paypal/captureOrder";
export { paypalWebhook } from "./paypal/webhook";

// Fusion 360 connection tokens
export {
  createFusionToken, revokeFusionToken, exchangeFusionToken,
} from "./fusion/tokens";

// Accounts
export { ensureAccount } from "./users/onUserCreate";
export { onStorageWrite, onStorageDelete } from "./storage/quota";
