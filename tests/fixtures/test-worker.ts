import { fileURLToPath } from "node:url";
import { pool } from "../../src/config/database.js";

import {
  claimJob,
  completeJob,
  failJob,
  renewLeaseAndCheckCancel,
  markJobCancelled,
  recoverExpiredJobs,
} from "../../src/jobs/job.repository.js";

import { createWorkerRuntime } from "../../src/jobs/worker-runtime.js";

process.env.FORGEQUEUE_HANDLER_REGISTRATION = fileURLToPath(
  new URL("./register-test-handlers.ts", import.meta.url)
);

const workerId = process.env.WORKER_ID ?? "integration-worker";

const runtime = createWorkerRuntime(
  {
    claimJob,
    completeJob,
    failJob,
    renewLease: renewLeaseAndCheckCancel,
    markJobCancelled,
    recoverExpiredJobs,
  },
  {
    workerId,
    leaseDurationSeconds: 30,
    heartbeatIntervalMs: 5000,
    maxExecutionTimeMs: 30000,
    pollIntervalMs: 100,
    recoveryIntervalMs: 1000,
  }
);

process.once("SIGTERM", () => runtime.stop());
process.once("SIGINT", () => runtime.stop());

runtime.start()
  .catch((error) => {
    console.error("TEST_WORKER_ERROR", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
