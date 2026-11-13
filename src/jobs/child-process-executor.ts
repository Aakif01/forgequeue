import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";
import { readFileSync } from "node:fs";

function getLinuxProcessStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const closingParen = stat.lastIndexOf(")");

  if (closingParen === -1) {
    throw new Error(`Invalid /proc/${pid}/stat`);
  }

  const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
  return fields[19];
}

export class ChildProcessExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildProcessExecutionError";
  }
}

interface ChildMessage {
  action?: string;
  success?: boolean;
  error?: string;
}

interface ChildProcessExecutorOptions {
  startupTimeoutMs?: number;
  cancellationGraceMs?: number;
  registrationModule?: string;
  env?: NodeJS.ProcessEnv;
}

export async function executeInChildProcess(
  type: string,
  payload: unknown,
  signal: AbortSignal,
  options: ChildProcessExecutorOptions = {}
): Promise<void> {
  if (signal.aborted) {
    throw new ChildProcessExecutionError(
      "Handler execution was aborted"
    );
  }

  const {
    startupTimeoutMs = 5000,
    cancellationGraceMs = 1000,
    registrationModule,
    env = {},
  } = options;

  const extension = extname(fileURLToPath(import.meta.url));

  const childEntry = fileURLToPath(
    new URL(`./handler-child${extension}`, import.meta.url)
  );

  const childArgs =
    extension === ".ts"
      ? ["--import", "tsx", childEntry]
      : [childEntry];

  if (
  process.platform !== "linux" &&
  process.platform !== "android"
) {
  throw new ChildProcessExecutionError(
    "Parent watchdog currently requires Linux"
  );
}

const parentPid = process.pid;
const parentStartTime = getLinuxProcessStartTime(parentPid);

  const child = spawn(process.execPath, childArgs, {
    env: {
      ...process.env,
      ...env,
      ...(registrationModule
        ? { FORGEQUEUE_HANDLER_REGISTRATION: registrationModule }
        : {}),
      FORGEQUEUE_PARENT_PID: String(parentPid),
FORGEQUEUE_PARENT_START_TIME: parentStartTime,
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let ready = false;
    let abortRequested = false;
    let startupTimer: ReturnType<typeof setTimeout>;
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(startupTimer);

      if (cancellationTimer) {
        clearTimeout(cancellationTimer);
      }

      signal.removeEventListener("abort", onAbort);
    };

    const fail = (error: Error) => {
      if (settled) return;

      settled = true;
      cleanup();

      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }

      reject(error);
    };

    const succeed = () => {
      if (settled) return;

      if (signal.aborted) {
        fail(
          new ChildProcessExecutionError(
            "Handler execution was aborted"
          )
        );
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    const onAbort = () => {
      if (settled) return;

      abortRequested = true;

      if (child.connected) {
        child.send({ action: "cancel" }, (error) => {
          if (error && !settled) {
            fail(
              new ChildProcessExecutionError(
                `Failed to send cancellation: ${error.message}`
              )
            );
          }
        });
      }

      cancellationTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, cancellationGraceMs);
    };

    startupTimer = setTimeout(() => {
      fail(
        new ChildProcessExecutionError(
          "Handler child startup timed out"
        )
      );
    }, startupTimeoutMs);

    signal.addEventListener("abort", onAbort, { once: true });

    child.on("message", (message: ChildMessage) => {
      if (message.action === "ready" && !ready) {
        ready = true;
        clearTimeout(startupTimer);

        child.send({ type, payload }, (error) => {
          if (error) {
            fail(
              new ChildProcessExecutionError(
                `Failed to send handler request: ${error.message}`
              )
            );
          }
        });

        return;
      }

      if (typeof message.success === "boolean") {
        if (message.success) {
          succeed();
        } else {
          fail(
            new ChildProcessExecutionError(
              message.error ?? "Handler execution failed"
            )
          );
        }
      }
    });

    child.on("error", (error) => {
      fail(
        new ChildProcessExecutionError(
          `Handler child process error: ${error.message}`
        )
      );
    });

    child.on("exit", (code, childSignal) => {
  if (!settled) {
    if (abortRequested) {
      fail(
        new ChildProcessExecutionError(
          "Handler execution was aborted"
        )
      );
      return;
    }

    fail(
      new ChildProcessExecutionError(
        `Handler child exited unexpectedly (code=${code}, signal=${childSignal})`
      )
    );
  }
});
  });
}
