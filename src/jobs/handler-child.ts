import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { getHandler } from "./handler.registry.js";

interface HandlerRequest {
  type: string;
  payload: unknown;
}

let started = false;
let watchdog: Worker | undefined;
let stoppingWatchdog = false;
let disconnecting = false;

const controller = new AbortController();

async function startParentWatchdog(): Promise<void> {
  const parentPid = Number(process.env.FORGEQUEUE_PARENT_PID);
  const parentStartTime = process.env.FORGEQUEUE_PARENT_START_TIME;

  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || !parentStartTime) {
    throw new Error("Missing or invalid parent process identity");
  }

  if (process.platform !== "linux" && process.platform !== "android") {
    throw new Error("Parent watchdog requires Linux");
  }

  const source = `
    const fs = require("node:fs");
    const { workerData } = require("node:worker_threads");

    function getProcessIdentity(pid) {
  const stat = fs.readFileSync(
    "/proc/" + pid + "/stat",
    "utf8"
  );

  const closingParen = stat.lastIndexOf(")");

  if (closingParen === -1) {
    throw new Error("Invalid process stat");
  }

  const fields = stat.slice(closingParen + 2)
    .trim()
    .split(/\\s+/);

  return {
    state: fields[0],
    startTime: fields[19],
  };
}

    const timer = setInterval(() => {
      try {
        const parent = getProcessIdentity(workerData.parentPid);

if (
  parent.state === "Z" ||
  parent.state === "X" ||
  parent.startTime !== workerData.parentStartTime
) {
  process.kill(process.pid, "SIGKILL");
}
      } catch (error) {
        process.kill(process.pid, "SIGKILL");
      }
    }, 100);
  `;

  const currentWatchdog = new Worker(source, {
    eval: true,
    workerData: {
      parentPid,
      parentStartTime,
    },
  });

  watchdog = currentWatchdog;

  await new Promise<void>((resolve, reject) => {
    let online = false;

    currentWatchdog.once("online", () => {
      online = true;
      resolve();
    });

    currentWatchdog.on("error", (error) => {
      if (!online) {
        reject(error);
        return;
      }

      if (!stoppingWatchdog) {
        console.error("[handler-child] Watchdog failed:", error);
        process.kill(process.pid, "SIGKILL");
      }
    });

    currentWatchdog.on("exit", (code) => {
      if (!stoppingWatchdog) {
        console.error(`[handler-child] Watchdog exited unexpectedly: ${code}`);

        process.kill(process.pid, "SIGKILL");
      }
    });
  });
}

async function stopParentWatchdog(): Promise<void> {
  stoppingWatchdog = true;

  const currentWatchdog = watchdog;
  watchdog = undefined;

  if (currentWatchdog) {
    await currentWatchdog.terminate();
  }
}

async function sendResult(
  message: { success: boolean; error?: string },
  exitCode: number,
): Promise<void> {
  try {
    await stopParentWatchdog();
  } catch (error) {
    console.error("[handler-child] Watchdog shutdown failed:", error);
    process.exitCode = 1;
    return;
  }

  process.exitCode = exitCode;

  if (!process.connected) {
    return;
  }

  disconnecting = true;

  process.send?.(message, (error) => {
    if (error) {
      process.exitCode = 1;
    }

    if (process.connected) {
      process.disconnect?.();
    }
  });
}

async function main(): Promise<void> {
  if (!process.send) {
    throw new Error("Handler child must be started with IPC enabled");
  }

  await startParentWatchdog();

  process.once("disconnect", () => {
    if (disconnecting) return;

    controller.abort();

    void stopParentWatchdog().finally(() => {
      process.exit(1);
    });
  });

  const registrationModule = process.env.FORGEQUEUE_HANDLER_REGISTRATION;

  if (registrationModule) {
    await import(pathToFileURL(registrationModule).href);
  } else {
    await import("./register-handlers.js");
  }

  process.send({ action: "ready" });

  process.on("message", async (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "action" in message &&
      message.action === "cancel"
    ) {
      controller.abort();
      return;
    }

    if (started) return;
    started = true;

    try {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        typeof message.type !== "string" ||
        !("payload" in message)
      ) {
        throw new Error("Invalid handler request");
      }

      const request = message as HandlerRequest;
      const handler = getHandler(request.type);

      if (!handler) {
        throw new Error(`No handler registered for: ${request.type}`);
      }

      await handler(request.payload, {
        signal: controller.signal,
      });

      if (controller.signal.aborted) {
        await sendResult({ success: false, error: "Handler aborted" }, 1);
        return;
      }

      await sendResult({ success: true }, 0);
    } catch (error) {
      await sendResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        1,
      );
    }
  });
}

main().catch(async (error) => {
  console.error("[handler-child] Startup failed:", error);

  try {
    await stopParentWatchdog();
  } finally {
    process.exit(1);
  }
});
