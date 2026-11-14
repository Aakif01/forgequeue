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

  const jobCount = 100;
  const workerCount = 20;
  const testRunId = `concurrency-${Date.now()}`;

  beforeAll(async () => {
    const schema = await readFile(
      new URL("../src/database/schema.sql", import.meta.url),
      "utf8"
    );

    await pool.query(schema);

    const registered = await registerClient(testRunId);
    clientId = registered.client.id;

    for (let i = 0; i < jobCount; i++) {
      await submitJob({
        clientId,
        type: "test.email",
        payload: { index: i },
        idempotencyKey: `${testRunId}-${i}`,
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

  it("allows concurrent workers to claim 100 distinct jobs", async () => {
    const successfulClaims = [];

    for (let round = 0; round < jobCount / workerCount; round++) {
      const claims = await Promise.all(
        Array.from({ length: workerCount }, (_, workerIndex) =>
          claimJob(
            `concurrent-worker-${round}-${workerIndex}`,
            30
          )
        )
      );

      successfulClaims.push(
        ...claims.filter((job) => job !== null)
      );
    }

    expect(successfulClaims).toHaveLength(jobCount);

    const claimedIds = successfulClaims.map((job) => job.id);
    const leaseTokens = successfulClaims.map(
      (job) => job.lease_token
    );

    expect(new Set(claimedIds).size).toBe(jobCount);
    expect(new Set(leaseTokens).size).toBe(jobCount);

    expect(
      successfulClaims.every(
        (job) =>
          job.status === "running" &&
          job.locked_by !== null &&
          job.lease_token !== null
      )
    ).toBe(true);

    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'running')::int AS running,
         COUNT(*)::int AS total
       FROM jobs
       WHERE client_id = $1`,
      [clientId]
    );

    expect(result.rows[0]).toEqual({
      pending: 0,
      running: jobCount,
      total: jobCount,
    });

    const databaseJobs = await pool.query(
      "SELECT id FROM jobs WHERE client_id = $1",
      [clientId]
    );

    expect(new Set(databaseJobs.rows.map((job) => job.id))).toEqual(
      new Set(claimedIds)
    );
  });
});
