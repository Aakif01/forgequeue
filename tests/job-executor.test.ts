import { describe, expect, it, vi } from "vitest";
import {
  executeWithHeartbeat,
  ExecutionTimeoutError,
  LeaseLostError,
  JobCancelledError,
} from "../src/jobs/job-executor.js";

const baseOptions = {
  jobId: "job-1",
  workerId: "worker-1",
  leaseToken: "lease-1",
  payload: {},
  leaseDurationSeconds: 30,
  heartbeatIntervalMs: 10,
  maxExecutionTimeMs: 1000,
  renewLease: vi.fn().mockResolvedValue({
    renewed: true,
    cancelRequested: false,
  }),
};

describe("Job executor", () => {
  it("completes a successful handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    await executeWithHeartbeat({
      ...baseOptions,
      handler,
    });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("aborts a handler when execution times out", async () => {
    let receivedSignal: AbortSignal | undefined;

    const handler = vi.fn(
      (_payload: unknown, context: { signal: AbortSignal }) => {
        receivedSignal = context.signal;

        return new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("Aborted")),
            { once: true }
          );
        });
      }
    );

    await expect(
      executeWithHeartbeat({
        ...baseOptions,
        handler,
        maxExecutionTimeMs: 20,
      })
    ).rejects.toBeInstanceOf(ExecutionTimeoutError);

    expect(receivedSignal?.aborted).toBe(true);
  });

  it("aborts a handler when lease ownership is lost", async () => {
    let receivedSignal: AbortSignal | undefined;

    const handler = vi.fn(
      (_payload: unknown, context: { signal: AbortSignal }) => {
        receivedSignal = context.signal;

        return new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("Aborted")),
            { once: true }
          );
        });
      }
    );

    const renewLease = vi.fn().mockResolvedValue({
      renewed: false,
      cancelRequested: false,
    });

    await expect(
      executeWithHeartbeat({
        ...baseOptions,
        handler,
        renewLease,
      })
    ).rejects.toBeInstanceOf(LeaseLostError);

    expect(receivedSignal?.aborted).toBe(true);
  });

  it("aborts a handler when cancellation is requested", async () => {
    let receivedSignal: AbortSignal | undefined;

    const handler = vi.fn(
      (_payload: unknown, context: { signal: AbortSignal }) => {
        receivedSignal = context.signal;

        return new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("Aborted")),
            { once: true }
          );
        });
      }
    );

    const renewLease = vi.fn().mockResolvedValue({
      renewed: true,
      cancelRequested: true,
    });

    await expect(
      executeWithHeartbeat({
        ...baseOptions,
        handler,
        renewLease,
      })
    ).rejects.toBeInstanceOf(JobCancelledError);

    expect(receivedSignal?.aborted).toBe(true);
  });

  it("does not report success if cancellation is detected before completion", async () => {
  let finishHandler!: () => void;

  const handler = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishHandler = resolve;
      })
  );

  const renewLease = vi.fn().mockResolvedValue({
  renewed: true,
  cancelRequested: true,
});

  const execution = executeWithHeartbeat({
    ...baseOptions,
    handler,
    renewLease,
  });

  await vi.waitFor(() => {
    expect(renewLease).toHaveBeenCalled();
  });

  finishHandler();

  await expect(execution).rejects.toBeInstanceOf(JobCancelledError);
});

  
it("does not schedule another heartbeat after execution finishes", async () => {
  vi.useFakeTimers();

  try {
    let finishHandler!: () => void;
    let resolveRenewal!: (result: {
      renewed: boolean;
      cancelRequested: boolean;
    }) => void;

    const renewal = new Promise<{
      renewed: boolean;
      cancelRequested: boolean;
    }>((resolve) => {
      resolveRenewal = resolve;
    });

    const renewLease = vi.fn(() => renewal);

    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishHandler = resolve;
        })
    );

    const execution = executeWithHeartbeat({
      ...baseOptions,
      handler,
      renewLease,
    });

    // Let the handler start.
    await vi.advanceTimersByTimeAsync(0);

    // Start a heartbeat and leave its database request pending.
    await vi.advanceTimersByTimeAsync(10);
    expect(renewLease).toHaveBeenCalledOnce();

    // Finish the handler while the heartbeat is still pending.
    finishHandler();
    await execution;

    // Complete the in-flight heartbeat after execution has finished.
    resolveRenewal({
      renewed: true,
      cancelRequested: false,
    });

    await vi.advanceTimersByTimeAsync(50);

    // No subsequent heartbeat should have been scheduled.
    expect(renewLease).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

});
