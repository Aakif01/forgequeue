
import { randomUUID } from "node:crypto";
import { pool } from "./config/database.js";

import {
  claimJob,
  completeJob,
  failJob,
  renewLeaseAndCheckCancel,
  markJobCancelled,
  recoverExpiredJobs,
} from "./jobs/job.repository.js";


import { createWorkerRuntime } from "./jobs/worker-runtime.js";

const workerId = process.env.WORKER_ID ?? `worker-${randomUUID()}`;

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
    heartbeatIntervalMs: 10_000,
    maxExecutionTimeMs: 15 * 60 * 1000,
    pollIntervalMs: 1000,
    recoveryIntervalMs: 5000,
  }
);

function handleShutdown(signal: string): void {
  console.log(
    `[${workerId}] Received ${signal}. Stopping new job claims...`
  );

  runtime.stop();
}

process.once("SIGINT", () => handleShutdown("SIGINT"));
process.once("SIGTERM", () => handleShutdown("SIGTERM"));

runtime.start()
  .catch((error) => {
    console.error("Worker stopped unexpectedly:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
