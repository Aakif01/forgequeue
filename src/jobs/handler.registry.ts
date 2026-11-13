export interface JobContext {
  signal: AbortSignal;
}

export type JobHandler = (
  payload: unknown,
  context: JobContext
) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerHandler(
  type: string,
  handler: JobHandler
): void {
  if (!type.trim()) {
    throw new Error("Handler type cannot be empty");
  }

  if (handlers.has(type)) {
    throw new Error(`Handler already registered: ${type}`);
  }

  handlers.set(type, handler);
}

export function getHandler(
  type: string
): JobHandler | undefined {
  return handlers.get(type);
}