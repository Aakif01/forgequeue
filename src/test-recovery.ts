import { randomUUID } from "node:crypto";
import { pool } from "./config/database.js";
import {
  claimJob,
  recoverExpiredJobs,
  completeJob,
} from "./jobs/job.repository.js";

async function main() {
  try {
    // Keep other pending test jobs out of this test.
    await pool.query(`
      UPDATE jobs
      SET run_at = NOW() + INTERVAL '1 day'
      WHERE status = 'pending'
        AND idempotency_key LIKE 'test-%'
    `);

    // Create a fresh job.
    const inserted = await pool.query(
      `
      INSERT INTO jobs (
        client_id, type, payload, idempotency_key
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      [
        "11111111-1111-1111-1111-111111111111",
        "test.email",
        JSON.stringify({ email: "stale@example.com" }),
        `stale-test-${randomUUID()}`,
      ]
    );

    // Worker A claims the job.
    const workerA = await claimJob("worker-A", 120);

    if (!workerA || !workerA.lease_token) {
      throw new Error("Worker A could not claim the job");
    }

    console.log("Worker A claimed:", workerA.id);

    // Simulate Worker A's lease expiring.
    await pool.query(
      `
      UPDATE jobs
      SET locked_until = NOW() - INTERVAL '1 second'
      WHERE id = $1
      `,
      [workerA.id]
    );

    // Recover the expired job.
    const recovered = await recoverExpiredJobs();

    if (!recovered.some((job) => job.id === workerA.id)) {
      throw new Error("Job was not recovered");
    }

    // Make it immediately eligible for the next claim.
    await pool.query(
      `UPDATE jobs SET run_at = NOW() WHERE id = $1`,
      [workerA.id]
    );

    // Worker B reclaims the same job.
    const workerB = await claimJob("worker-B", 120);

    if (!workerB || workerB.id !== workerA.id || !workerB.lease_token) {
      throw new Error("Worker B did not reclaim the expected job");
    }

    console.log("Worker B reclaimed:", workerB.id);

    // Worker A attempts completion with its old token.
    const staleResult = await completeJob(
      workerA.id,
      "worker-A",
      workerA.lease_token
    );

    console.log("Worker A completion:", staleResult);

    // Worker B completes with its current token.
    const validResult = await completeJob(
      workerB.id,
      "worker-B",
      workerB.lease_token
    );

    console.log("Worker B completion:", validResult?.status);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);