import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  executeInChildProcess,
} from "../src/jobs/child-process-executor.js";

const registrationModule = resolve(
  "tests/fixtures/register-test-handlers.ts"
);

describe("Child process executor", () => {
  it("executes a successful handler", async () => {
    const controller = new AbortController();

    await expect(
      executeInChildProcess(
        "test.integration",
        { message: "child test" },
        controller.signal,
        {
          registrationModule,
          env: { WORKER_ID: "child-executor-test" },
        }
      )
    ).resolves.toBeUndefined();
  });

  it("reports handler failures", async () => {
    const controller = new AbortController();

    await expect(
      executeInChildProcess(
        "test.integration.failure",
        {},
        controller.signal,
        {
          registrationModule,
          env: { WORKER_ID: "child-executor-test" },
        }
      )
    ).rejects.toThrow(
      "Intentional integration test failure"
    );
  });

  it("force-kills a handler that ignores cancellation", async () => {
    const controller = new AbortController();

    const execution = executeInChildProcess(
      "test.integration.crash",
      {},
      controller.signal,
      {
        registrationModule,
        cancellationGraceMs: 200,
        env: { WORKER_ID: "integration-crasher" },
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 500));

    const startedAt = Date.now();
    controller.abort();

    await expect(execution).rejects.toThrow(
      "Handler execution was aborted"
    );

    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
