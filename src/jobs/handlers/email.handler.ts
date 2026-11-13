import type { JobContext } from "../handler.registry.js";

export async function emailHandler(
  payload: unknown,
  context: JobContext
): Promise<void> {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("email" in payload) ||
    typeof payload.email !== "string"
  ) {
    throw new Error("Invalid email job payload");
  }

  if (context.signal.aborted) {
    throw new Error("Email processing aborted");
  }

  console.log(`Processing email for: ${payload.email}`);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      context.signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };

    const onAbort = () => {
      cleanup();
      reject(new Error("Email processing aborted"));
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 45000);

    context.signal.addEventListener("abort", onAbort, {
      once: true,
    });
  });

  console.log(`Email processed for: ${payload.email}`);
}