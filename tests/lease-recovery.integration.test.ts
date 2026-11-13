import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { pool } from "../src/config/database.js";
import { registerClient } from "../src/clients/client.service.js";
import { submitJob } from "../src/jobs/job.service.js";
import {
  claimJob,
  completeJob,
  failJob,
  markJobCancelled,
  recoverExpiredJobs,
  renewLeaseAndCheckCancel,
} from "../src/jobs/job.repository.js";

describe("Lease and recovery integration tests", () => {
  let clientId: string;

  beforeAll(async () => {
    const registered = await registerClient(
      `lease-test-${Date.now()}`
    );

    clientId = registered.client.id;
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

  beforeEach(async () => {
  await pool.query(
    "DELETE FROM jobs WHERE client_id = $1",
    [clientId]
  );
});

  async function createJob(key: string) {
    return submitJob({
      clientId,
      type: "test.email",
      payload: { test: true },
      idempotencyKey: key,
    });
  }

  it("recovers an expired job and makes it pending again", async () => {
    await createJob("lease-recovery-1");

    const claimed = await claimJob("worker-recovery", 30);

    expect(claimed).not.toBeNull();

    await pool.query(
      `UPDATE jobs
       SET locked_until = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [claimed!.id]
    );

    const recovered = await recoverExpiredJobs();

    const result = recovered.find(
      (job) => job.id === claimed!.id
    );

    expect(result).toBeDefined();
    expect(result!.status).toBe("pending");
    expect(result!.locked_by).toBeNull();
    expect(result!.lease_token).toBeNull();
  });

  it("rejects completion from a stale worker after lease expiration", async () => {
    await createJob("lease-stale-1");

    const claimed = await claimJob("worker-stale", 30);

    expect(claimed).not.toBeNull();

    await pool.query(
      `UPDATE jobs
       SET locked_until = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [claimed!.id]
    );

    const completion = await completeJob(
      claimed!.id,
      "worker-stale",
      claimed!.lease_token!
    );

    expect(completion).toBeNull();
  });

  it("marks an exhausted job as dead during recovery", async () => {
    await createJob("lease-dead-1");

    const claimed = await claimJob("worker-dead", 30);

    expect(claimed).not.toBeNull();

    await pool.query(
      `UPDATE jobs
       SET
         max_attempts = attempts,
         locked_until = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [claimed!.id]
    );

    const recovered = await recoverExpiredJobs();

    const result = recovered.find(
      (job) => job.id === claimed!.id
    );

    expect(result).toBeDefined();
    expect(result!.status).toBe("dead");
    expect(result!.locked_by).toBeNull();
    expect(result!.lease_token).toBeNull();
  });

  it("prevents a stale worker from completing a reclaimed job", async () => {
  await createJob("lease-stale-reclaim-1");

  const workerA = await claimJob("worker-A", 30);
  expect(workerA).not.toBeNull();

  const oldToken = workerA!.lease_token!;

  await pool.query(
    `UPDATE jobs
     SET locked_until = NOW() - INTERVAL '1 second'
     WHERE id = $1`,
    [workerA!.id]
  );

  const recovered = await recoverExpiredJobs();

  expect(
    recovered.some((job) => job.id === workerA!.id)
  ).toBe(true);

  // Recovery applies retry backoff. Make this test job
  // immediately eligible so we can test ownership.
  await pool.query(
    "UPDATE jobs SET run_at = NOW() WHERE id = $1",
    [workerA!.id]
  );

  const workerB = await claimJob("worker-B", 30);

  expect(workerB).not.toBeNull();
  expect(workerB!.id).toBe(workerA!.id);

  const newToken = workerB!.lease_token!;
  expect(newToken).not.toBe(oldToken);

  const staleCompletion = await completeJob(
    workerA!.id,
    "worker-A",
    oldToken
  );

  expect(staleCompletion).toBeNull();

  const current = await pool.query(
    `SELECT status, locked_by, lease_token
     FROM jobs WHERE id = $1`,
    [workerB!.id]
  );

  expect(current.rows[0].status).toBe("running");
  expect(current.rows[0].locked_by).toBe("worker-B");
  expect(current.rows[0].lease_token).toBe(newToken);

  const validCompletion = await completeJob(
    workerB!.id,
    "worker-B",
    newToken
  );

  expect(validCompletion?.status).toBe("completed");
});

  it("retries failed jobs and eventually marks them dead", async () => {
  await createJob("retry-exhaustion-1");

  // Attempt 1
  const firstClaim = await claimJob("retry-worker-1", 30);

  expect(firstClaim).not.toBeNull();
  expect(firstClaim!.attempts).toBe(1);

  const firstFailure = await failJob(
    firstClaim!.id,
    "retry-worker-1",
    firstClaim!.lease_token!,
    new Error("First attempt failed")
  );

  expect(firstFailure!.status).toBe("pending");
  expect(firstFailure!.attempts).toBe(1);
  expect(firstFailure!.last_error).toBe("First attempt failed");

  // Make the job immediately eligible instead of waiting for backoff.
  await pool.query(
    "UPDATE jobs SET run_at = NOW() WHERE id = $1",
    [firstClaim!.id]
  );

  // Attempt 2
  const secondClaim = await claimJob("retry-worker-2", 30);

  expect(secondClaim!.id).toBe(firstClaim!.id);
  expect(secondClaim!.attempts).toBe(2);

  const secondFailure = await failJob(
    secondClaim!.id,
    "retry-worker-2",
    secondClaim!.lease_token!,
    new Error("Second attempt failed")
  );

  expect(secondFailure!.status).toBe("pending");

  await pool.query(
    "UPDATE jobs SET run_at = NOW() WHERE id = $1",
    [firstClaim!.id]
  );

  // Attempt 3: max_attempts defaults to 3.
  const thirdClaim = await claimJob("retry-worker-3", 30);

  expect(thirdClaim!.id).toBe(firstClaim!.id);
  expect(thirdClaim!.attempts).toBe(3);

  const thirdFailure = await failJob(
    thirdClaim!.id,
    "retry-worker-3",
    thirdClaim!.lease_token!,
    new Error("Final attempt failed")
  );

  expect(thirdFailure!.status).toBe("dead");
  expect(thirdFailure!.attempts).toBe(3);
  expect(thirdFailure!.last_error).toBe("Final attempt failed");
  expect(thirdFailure!.locked_by).toBeNull();
  expect(thirdFailure!.lease_token).toBeNull();
});

  it("prevents completion after cancellation has been requested", async () => {
  await createJob("cancel-race-1");

  const claimed = await claimJob("cancel-worker-1", 30);
  expect(claimed).not.toBeNull();

  // Simulate the API recording a cancellation request.
  await pool.query(
    `UPDATE jobs
     SET cancel_requested = TRUE
     WHERE id = $1`,
    [claimed!.id]
  );

  // Completion must now be rejected.
  const completion = await completeJob(
    claimed!.id,
    "cancel-worker-1",
    claimed!.lease_token!
  );

  expect(completion).toBeNull();

  // Worker acknowledges cancellation.
  const cancelled = await markJobCancelled(
    claimed!.id,
    "cancel-worker-1",
    claimed!.lease_token!
  );

  expect(cancelled).toBe(true);

  const result = await pool.query(
    `SELECT status, cancel_requested, locked_by, lease_token
     FROM jobs
     WHERE id = $1`,
    [claimed!.id]
  );

  expect(result.rows[0].status).toBe("cancelled");
  expect(result.rows[0].cancel_requested).toBe(true);
  expect(result.rows[0].locked_by).toBeNull();
  expect(result.rows[0].lease_token).toBeNull();
});

it("cancels a job when its worker reports failure after cancellation", async () => {
  await createJob("cancel-race-2");

  const claimed = await claimJob("cancel-worker-2", 30);
  expect(claimed).not.toBeNull();

  await pool.query(
    `UPDATE jobs
     SET cancel_requested = TRUE
     WHERE id = $1`,
    [claimed!.id]
  );

  const result = await failJob(
    claimed!.id,
    "cancel-worker-2",
    claimed!.lease_token!,
    new Error("Handler aborted")
  );

  expect(result).not.toBeNull();
  expect(result!.status).toBe("cancelled");
  expect(result!.cancel_requested).toBe(true);
  expect(result!.locked_by).toBeNull();
  expect(result!.lease_token).toBeNull();
});

  it("renews a valid worker lease successfully", async () => {
  await createJob("heartbeat-valid-1");

  const claimed = await claimJob("heartbeat-worker-1", 30);
  expect(claimed).not.toBeNull();

  const before = await pool.query(
    "SELECT locked_until FROM jobs WHERE id = $1",
    [claimed!.id]
  );

  const result = await renewLeaseAndCheckCancel(
    claimed!.id,
    "heartbeat-worker-1",
    claimed!.lease_token!,
    60
  );

  const after = await pool.query(
    "SELECT locked_until FROM jobs WHERE id = $1",
    [claimed!.id]
  );

  expect(result.renewed).toBe(true);
  expect(result.cancelRequested).toBe(false);
  expect(after.rows[0].locked_until.getTime()).toBeGreaterThan(
    before.rows[0].locked_until.getTime()
  );
});

it("rejects heartbeat renewal after lease expiration", async () => {
  await createJob("heartbeat-expired-1");

  const claimed = await claimJob("heartbeat-worker-2", 30);
  expect(claimed).not.toBeNull();

  await pool.query(
    `UPDATE jobs
     SET locked_until = NOW() - INTERVAL '1 second'
     WHERE id = $1`,
    [claimed!.id]
  );

  const result = await renewLeaseAndCheckCancel(
    claimed!.id,
    "heartbeat-worker-2",
    claimed!.lease_token!,
    30
  );

  expect(result.renewed).toBe(false);
  expect(result.cancelRequested).toBe(false);
});

it("rejects heartbeat renewal using a stale lease token", async () => {
  await createJob("heartbeat-stale-1");

  const workerA = await claimJob("heartbeat-worker-A", 30);
  expect(workerA).not.toBeNull();

  await pool.query(
    `UPDATE jobs
     SET locked_until = NOW() - INTERVAL '1 second'
     WHERE id = $1`,
    [workerA!.id]
  );

  await recoverExpiredJobs();

  await pool.query(
    "UPDATE jobs SET run_at = NOW() WHERE id = $1",
    [workerA!.id]
  );

  const workerB = await claimJob("heartbeat-worker-B", 30);

  expect(workerB).not.toBeNull();
  expect(workerB!.id).toBe(workerA!.id);

  const result = await renewLeaseAndCheckCancel(
    workerA!.id,
    "heartbeat-worker-A",
    workerA!.lease_token!,
    30
  );

  expect(result.renewed).toBe(false);

  const current = await pool.query(
    `SELECT locked_by, lease_token
     FROM jobs WHERE id = $1`,
    [workerB!.id]
  );

  expect(current.rows[0].locked_by).toBe("heartbeat-worker-B");
  expect(current.rows[0].lease_token).toBe(workerB!.lease_token);
});
});
