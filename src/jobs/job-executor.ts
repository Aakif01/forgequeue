import type { JobHandler } from "./handler.registry.js";

export class LeaseLostError extends Error {
  constructor() {
    super("Worker lost ownership of the job");
    this.name = "LeaseLostError";
  }
}

export class ExecutionTimeoutError extends Error {
  constructor() {
    super("Job exceeded maximum execution time");
    this.name = "ExecutionTimeoutError";
  }
}

export class JobCancelledError extends Error {
  constructor() {
    super("Job was cancelled");
    this.name = "JobCancelledError";
  }
}

interface LeaseRenewalResult {
  renewed: boolean;
  cancelRequested: boolean;
}

interface ExecuteJobOptions {
  jobId: string;
  workerId: string;
  leaseToken: string;
  handler: JobHandler;
  payload: unknown;
  leaseDurationSeconds: number;
  heartbeatIntervalMs: number;
  maxExecutionTimeMs: number;
  renewLease: (
    jobId: string,
    workerId: string,
    leaseToken: string,
    leaseDurationSeconds: number
  ) => Promise<LeaseRenewalResult>;
}

export async function executeWithHeartbeat(
  options: ExecuteJobOptions
): Promise<void> {
  const {
    jobId,
    workerId,
    leaseToken,
    handler,
    payload,
    leaseDurationSeconds,
    heartbeatIntervalMs,
    maxExecutionTimeMs,
    renewLease,
  } = options;

  const controller = new AbortController();

  let heartbeatTimer: ReturnType<typeof setTimeout>;
  let timeoutTimer: ReturnType<typeof setTimeout>;

  let resolveLeaseLost!: () => void;
  let resolveTimeout!: () => void;
  let resolveCancellation!: () => void;

  let terminationError: Error | undefined;
  let finished = false;
  let cancellationDetected = false;

  const leaseLostPromise = new Promise<void>((resolve) => {
    resolveLeaseLost = resolve;
  });

  const timeoutPromise = new Promise<void>((resolve) => {
    resolveTimeout = resolve;
  });

  const cancellationPromise = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });

  const handlerPromise = Promise.resolve()
    .then(() => handler(payload, { signal: controller.signal }))
    .then(
      () => ({ success: true as const }),
      (error: unknown) => ({ success: false as const, error })
    );

  const stopHeartbeat = () => {
    clearTimeout(heartbeatTimer);
  };

  const scheduleHeartbeat = () => {
    if (finished) {
  return;
    }
    heartbeatTimer = setTimeout(async () => {
      try {
        const result = await renewLease(
          jobId,
          workerId,
          leaseToken,
          leaseDurationSeconds
        );

        if (finished) {
  return;
        }

        if (!result.renewed) {
          terminationError = new LeaseLostError();
          controller.abort();
          resolveLeaseLost();
          return;
        }

        if (result.cancelRequested && !cancellationDetected) {
          cancellationDetected = true;
          terminationError = new JobCancelledError();

          console.log(`[${workerId}] Cancellation requested: ${jobId}`);

          controller.abort();
          resolveCancellation();
        }

        scheduleHeartbeat();
      } catch (error) {
        if (finished) {
  return;
        }
        terminationError = new LeaseLostError();
        controller.abort();
        resolveLeaseLost();

        console.error(
          `[${workerId}] Heartbeat failed:`,
          error instanceof Error ? error.message : error
        );
      }
    }, heartbeatIntervalMs);
  };

  scheduleHeartbeat();

  timeoutTimer = setTimeout(() => {
    terminationError = new ExecutionTimeoutError();
    controller.abort();
    resolveTimeout();
  }, maxExecutionTimeMs);

  try {
    const outcome = await Promise.race([
      handlerPromise.then((result) => ({
        type: "handler" as const,
        result,
      })),
      leaseLostPromise.then(() => ({ type: "lease-lost" as const })),
      timeoutPromise.then(() => ({ type: "timeout" as const })),
      cancellationPromise.then(() => ({ type: "cancelled" as const })),
    ]);

    if (outcome.type === "handler") {
      if (!outcome.result.success) {
        throw terminationError ?? outcome.result.error;
      }

      return;
    }

    // Wait for cooperative handlers to finish after receiving the abort.
    await handlerPromise;

    throw terminationError ?? new Error(
      `Job execution interrupted: ${outcome.type}`
    );
  } finally {
    finished = true;
    stopHeartbeat();
    clearTimeout(timeoutTimer);
  }
}
