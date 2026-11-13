
import { randomBytes, createHash } from "node:crypto";

const API_KEY_PREFIX = "fq_live_";

export function generateApiKey(): string {
  const secret = randomBytes(32).toString("hex");

  return `${API_KEY_PREFIX}${secret}`;
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256")
    .update(apiKey)
    .digest("hex");
}
