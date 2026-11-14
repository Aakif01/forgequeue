import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  executeInChildProcess,
} from "../src/jobs/child-process-executor.js";

const registrationModule = resolve(
  "tests/fixtures/register-test-handlers.ts"
);

function isProcessTerminated(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    const state = stat.slice(closingParen + 2).trim().split(/\s+/)[0];

    return state === "Z" || state === "X";
  } catch {
    return true;
  }
}

async function waitForProcessTermination(
  pid: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (isProcessTerminated(pid)) return;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Process ${pid} did not terminate`);
}

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
    ).rejects.toThrow("Intentional integration test failure");
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

  it("kills the handler when its parent process dies", async () => {
    const helper = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("tests/fixtures/watchdog-parent.ts"),
      ],
      {
        stdio: ["ignore", "pipe", "inherit"],
      }
    );

    let handlerPid: number | undefined;

    try {
      handlerPid = await new Promise<number>((resolve, reject) => {
        let output = "";

        const timer = setTimeout(() => {
          reject(new Error("Handler PID was not reported"));
        }, 8000);

        helper.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();

          const match = output.match(/TEST_BLOCKING_PID:(\d+)/);

          if (match) {
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
        });

        helper.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });

        helper.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Helper exited before handler started"));
        });
      });

      helper.kill("SIGKILL");

      await new Promise<void>((resolve) => {
        helper.once("exit", () => resolve());
      });

      await waitForProcessTermination(handlerPid, 8000);

      expect(isProcessTerminated(handlerPid)).toBe(true);
    } finally {
      if (helper.exitCode === null && helper.signalCode === null) {
        helper.kill("SIGKILL");
      }

      if (handlerPid && !isProcessTerminated(handlerPid)) {
        process.kill(handlerPid, "SIGKILL");
      }
    }
  }, 20000);
});
