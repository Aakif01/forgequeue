import { resolve } from "node:path";
import { executeInChildProcess } from "../../src/jobs/child-process-executor.js";

const registrationModule = resolve(
  "tests/fixtures/register-test-handlers.ts"
);

const controller = new AbortController();

executeInChildProcess(
  "test.integration.blocking",
  {},
  controller.signal,
  {
    registrationModule,
    env: { WORKER_ID: "watchdog-parent" },
  }
).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
