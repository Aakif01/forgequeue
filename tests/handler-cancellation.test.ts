import { describe, expect, it } from "vitest";
import { emailHandler } from "../src/jobs/handlers/email.handler.js";

describe("Email handler cancellation", () => {
  it("stops processing when its AbortSignal is triggered", async () => {
    const controller = new AbortController();

    const execution = emailHandler(
      { email: "test@example.com" },
      { signal: controller.signal }
    );

    controller.abort();

    await expect(execution).rejects.toThrow(
      "Email processing aborted"
    );
  });

  it("rejects execution when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      emailHandler(
        { email: "test@example.com" },
        { signal: controller.signal }
      )
    ).rejects.toThrow("Email processing aborted");
  });
});