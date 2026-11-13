import { registerHandler } from "../../src/jobs/handler.registry.js";

registerHandler("test.integration", async (payload) => {
  console.log("TEST_HANDLER_EXECUTED", JSON.stringify(payload));
});

registerHandler("test.integration.failure", async () => {
  throw new Error("Intentional integration test failure");
});

registerHandler("test.integration.crash", async () => {
  if (process.env.WORKER_ID === "integration-crasher") {
    console.log(`TEST_HANDLER_PID:${process.pid}`);

    await new Promise<void>(() => {});
  }
});

registerHandler("test.integration.graceful", async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 500);
  });
});

registerHandler("test.integration.blocking", () => {
  console.log(`TEST_BLOCKING_PID:${process.pid}`);

  while (true) {
    // Deliberately block the event loop for testing.
  }
});