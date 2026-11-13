import type { Job } from "./job.repository.js";
import type { JobHandler } from "./handler.registry.js";
import {
  executeWithHeartbeat,
  LeaseLostError,
  JobCancelledError,
} from "./job-executor.js";
import { executeInChildProcess } from "./child-process-executor.js";

export interface WorkerRuntimeDependencies {
  claimJob: (
    workerId: string,
    leaseDurationSeconds: number
  ) => Promise<Job | null>;

  completeJob: (
    jobId: string,
    workerId: string,
    leaseToken: string
  ) => Promise<Job | null>;

  failJob: (
    jobId: string,
    workerId: string,
    leaseToken: string,
    error: unknown
  ) => Promise<Job | null>;

  renewLease: (
    jobId: string,
    workerId: string,
    leaseToken: string,
    leaseDurationSeconds: number
  ) => Promise<{
    renewed: boolean;
    cancelRequested: boolean;
  }>;

  markJobCancelled: (
    jobId: string,
    workerId: string,
    leaseToken: string
  ) => Promise<boolean>;

  recoverExpiredJobs: () => Promise<Job[]>;
}

export interface WorkerRuntimeConfig {
  workerId: string;
  leaseDurationSeconds: number;
  heartbeatIntervalMs: number;
  maxExecutionTimeMs: number;
  pollIntervalMs: number;
  recoveryIntervalMs: number;
}

export interface WorkerRuntime {
  start(): Promise<void>;
  stop(): void;
}

async function processJob(
  dependencies: WorkerRuntimeDependencies,
  config: WorkerRuntimeConfig
): Promise<boolean> {
  const {
    claimJob,
    completeJob,
    failJob,
    renewLease,
    markJobCancelled,
  } = dependencies;

  const job = await claimJob(
    config.workerId,
    config.leaseDurationSeconds
  );

  if (!job) {
    return false;
  }

  console.log(`[${config.workerId}] Claimed job: ${job.id}`);

  if (!job.lease_token) {
    console.error(`[${config.workerId}] Missing lease token: ${job.id}`);
    return true;
  }

  const handler: JobHandler = (payload, context) =>
    executeInChildProcess(job.type, payload, context.signal);

  try {
    await executeWithHeartbeat({
      jobId: job.id,
      workerId: config.workerId,
      leaseToken: job.lease_token,
      handler,
      payload: job.payload,
      leaseDurationSeconds: config.leaseDurationSeconds,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      maxExecutionTimeMs: config.maxExecutionTimeMs,
      renewLease,
    });

    const completed = await completeJob(
      job.id,
      config.workerId,
      job.lease_token
    );

    if (completed) {
      console.log(`[${config.workerId}] Job completed: ${job.id}`);
    } else {
      console.warn(`[${config.workerId}] Completion rejected: ${job.id}`);
    }
  } catch (error) {
    console.error(`[${config.workerId}] Job execution failed:`, error);

    if (error instanceof JobCancelledError) {
      const cancelled = await markJobCancelled(
        job.id,
        config.workerId,
        job.lease_token
      );

      if (cancelled) {
        console.log(`[${config.workerId}] Job cancelled: ${job.id}`);
      }

      return true;
    }

    if (error instanceof LeaseLostError) {
      console.warn(`[${config.workerId}] Ownership lost. Not updating job.`);
      return true;
    }

    const failed = await failJob(
      job.id,
      config.workerId,
      job.lease_token,
      error
    );

    if (failed) {
      console.log(`[${config.workerId}] Job status: ${failed.status}`);
    }
  }

  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWorkerRuntime(
  dependencies: WorkerRuntimeDependencies,
  config: WorkerRuntimeConfig
): WorkerRuntime {
  let isRunning = false;
  let startPromise: Promise<void> | null = null;

  return {
    start(): Promise<void> {
      if (startPromise) {
        return startPromise;
      }

      isRunning = true;

      startPromise = (async () => {
        console.log(`[${config.workerId}] Worker started`);

        let lastRecoveryTime = 0;

        while (isRunning) {
          try {
            const now = Date.now();

            if (now - lastRecoveryTime >= config.recoveryIntervalMs) {
              lastRecoveryTime = now;

              const recoveredJobs =
                await dependencies.recoverExpiredJobs();

              if (recoveredJobs.length > 0) {
                console.log(
                  `[${config.workerId}] Recovered ${recoveredJobs.length} expired job(s)`
                );
              }
            }

            if (!isRunning) {
              break;
            }

            const processed = await processJob(dependencies, config);

            if (!processed && isRunning) {
              await sleep(config.pollIntervalMs);
            }
          } catch (error) {
            console.error(`[${config.workerId}] Worker error:`, error);

            if (isRunning) {
              await sleep(config.pollIntervalMs);
            }
          }
        }

        console.log(`[${config.workerId}] Worker shutting down`);
      })();

      return startPromise;
    },

    stop(): void {
      isRunning = false;
    },
  };
}
