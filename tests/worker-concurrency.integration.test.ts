import { readFile } from "node:fs/promises";

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { pool } from "../src/config/database.js";
import { registerClient } from "../src/clients/client.service.js";
import { submitJob } from "../src/jobs/job.service.js";
import { claimJob } from "../src/jobs/job.repository.js";

describe("Worker concurrency integration tests", () => {
  let clientId: string;

  beforeAll(async () => {
    const schema = await readFile(
      new URL("../src/database/schema.sql", import.meta.url),
      "utf8"
    );

    await pool.query(schema);

    const registered = await registerClient(
      `concurrency-${Date.now()}`
    );

    clientId = registered.client.id;

    // Create 12 independent jobs for 12 concurrent claim attempts.
    for (let i = 0; i < 12; i++) {
      await submitJob({
        clientId,
        type: "test.email",
        payload: { index: i },
        idempotencyKey: `concurrency-${Date.now()}-${i}`,
      });
    }
  });

  afterAll(async () => {
    try {
      if (clientId) {
        await pool.query(
          "DELETE FROM jobs WHERE client_id = $1",
          [clientId]
        );

        await pool.query(
          "DELETE FROM clients WHERE id = $1",
          [clientId]
        );
      }
    } finally {
      await pool.end();
    }
  });

  it("allows concurrent workers to claim distinct jobs", async () => {
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        claimJob(`concurrent-worker-${i}`, 30)
      )
    );

    const successfulClaims = claims.filter(
      (job) => job !== null
    );

    const claimedIds = successfulClaims.map(
      (job) => job.id
    );

    expect(successfulClaims).toHaveLength(12);
    expect(new Set(claimedIds).size).toBe(12);

    expect(
      successfulClaims.every(
        (job) => job.status === "running"
      )
    ).toBe(true);

    expect(
      successfulClaims.every(
        (job) => job.locked_by !== null &&
                 job.lease_token !== null
      )
    ).toBe(true);

    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM jobs
       WHERE client_id = $1
         AND status = 'pending'`,
      [clientId]
    );

    expect(remaining.rows[0].count).toBe(0);
  });
});
