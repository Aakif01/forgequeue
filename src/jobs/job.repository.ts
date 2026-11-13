import type { QueryResultRow } from "pg";
import { pool } from "../config/database.js";

export interface Job extends QueryResultRow {
  id: string;
  client_id: string;
  type: string;
  payload: unknown;
  status: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_until: Date | null;
  lease_token: string | null;
  last_error: string | null;
  cancel_requested: boolean;
  run_at: Date;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface LeaseRenewalResult extends QueryResultRow {
  cancel_requested: boolean;
}

export async function claimJob(
  workerId: string,
  leaseDurationSeconds = 30
): Promise<Job | null> {
  if (!workerId.trim()) {
    throw new Error("Worker ID cannot be empty");
  }

  if (
    !Number.isInteger(leaseDurationSeconds) ||
    leaseDurationSeconds <= 0
  ) {
    throw new Error("Lease duration must be a positive integer");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query<Job>(
      `
      WITH candidate AS (
        SELECT id
        FROM jobs
        WHERE status = 'pending'
          AND run_at <= NOW()
          AND attempts < max_attempts
          AND cancel_requested = FALSE
        ORDER BY run_at ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs AS j
      SET
        status = 'running',
        locked_by = $1,
        locked_until = NOW() + ($2 * INTERVAL '1 second'),
        lease_token = gen_random_uuid(),
        attempts = j.attempts + 1,
        updated_at = NOW()
      FROM candidate
      WHERE j.id = candidate.id
      RETURNING j.*;
      `,
      [workerId, leaseDurationSeconds]
    );

    await client.query("COMMIT");

    return result.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverExpiredJobs(
  batchSize = 100
): Promise<Job[]> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("Batch size must be a positive integer");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query<Job>(
      `
      WITH expired_jobs AS (
        SELECT id
        FROM jobs
        WHERE status = 'running'
          AND locked_until <= NOW()
        ORDER BY locked_until ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs AS j
      SET
        status = CASE
          WHEN j.cancel_requested THEN 'cancelled'
          WHEN j.attempts >= j.max_attempts THEN 'dead'
          ELSE 'pending'
        END,
        locked_by = NULL,
        locked_until = NULL,
        lease_token = NULL,
        run_at = CASE
          WHEN NOT j.cancel_requested
               AND j.attempts < j.max_attempts THEN
            NOW() + (
              LEAST(
                POWER(2, GREATEST(j.attempts - 1, 0)) * 5,
                3600
              ) + random() * 5
            ) * INTERVAL '1 second'
          ELSE j.run_at
        END,
        updated_at = NOW()
      FROM expired_jobs
      WHERE j.id = expired_jobs.id
      RETURNING j.*;
      `,
      [batchSize]
    );

    await client.query("COMMIT");

    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeJob(
  jobId: string,
  workerId: string,
  leaseToken: string
): Promise<Job | null> {
  if (!jobId || !workerId.trim() || !leaseToken) {
    throw new Error("Job ID, worker ID and lease token are required");
  }

  const result = await pool.query<Job>(
    `
    UPDATE jobs
    SET
      status = 'completed',
      completed_at = NOW(),
      updated_at = NOW(),
      locked_by = NULL,
      locked_until = NULL,
      lease_token = NULL
    WHERE id = $1
      AND status = 'running'
      AND locked_by = $2
      AND lease_token = $3
      AND locked_until > NOW()
      AND cancel_requested = FALSE
    RETURNING *;
    `,
    [jobId, workerId, leaseToken]
  );

  return result.rows[0] ?? null;
}

export async function failJob(
  jobId: string,
  workerId: string,
  leaseToken: string,
  error: unknown
): Promise<Job | null> {
  const errorMessage =
    error instanceof Error ? error.message : String(error);

  const result = await pool.query<Job>(
    `
    UPDATE jobs
    SET
      status = CASE
        WHEN cancel_requested THEN 'cancelled'
        WHEN attempts >= max_attempts THEN 'dead'
        ELSE 'pending'
      END,
      last_error = $4,
      run_at = CASE
        WHEN NOT cancel_requested
             AND attempts < max_attempts THEN
          NOW() + (
            LEAST(
              POWER(2, GREATEST(attempts - 1, 0)) * 5,
              3600
            ) + random() * 5
          ) * INTERVAL '1 second'
        ELSE run_at
      END,
      locked_by = NULL,
      locked_until = NULL,
      lease_token = NULL,
      updated_at = NOW()
    WHERE id = $1
      AND status = 'running'
      AND locked_by = $2
      AND lease_token = $3
      AND locked_until > NOW()
    RETURNING *;
    `,
    [jobId, workerId, leaseToken, errorMessage.slice(0, 4000)]
  );

  return result.rows[0] ?? null;
}

export async function renewLease(
  jobId: string,
  workerId: string,
  leaseToken: string,
  leaseDurationSeconds = 30
): Promise<boolean> {
  if (!jobId || !workerId.trim() || !leaseToken) {
    throw new Error("Job ID, worker ID and lease token are required");
  }

  if (
    !Number.isInteger(leaseDurationSeconds) ||
    leaseDurationSeconds <= 0
  ) {
    throw new Error("Lease duration must be a positive integer");
  }

  const result = await pool.query(
    `
    UPDATE jobs
    SET
      locked_until = NOW() + ($4 * INTERVAL '1 second'),
      updated_at = NOW()
    WHERE id = $1
      AND status = 'running'
      AND locked_by = $2
      AND lease_token = $3
      AND locked_until > NOW()
    RETURNING id;
    `,
    [jobId, workerId, leaseToken, leaseDurationSeconds]
  );

  return result.rowCount === 1;
}

export async function renewLeaseAndCheckCancel(
  jobId: string,
  workerId: string,
  leaseToken: string,
  leaseSeconds: number
): Promise<{ renewed: boolean; cancelRequested: boolean }> {
  if (!jobId || !workerId.trim() || !leaseToken) {
  throw new Error("Job ID, worker ID and lease token are required");
}

if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) {
  throw new Error("Lease duration must be a positive integer");
}
  const result = await pool.query<LeaseRenewalResult>(
    `
    UPDATE jobs
    SET
      locked_until = NOW() + make_interval(secs => $4::double precision),
      updated_at = NOW()
    WHERE id = $1
      AND locked_by = $2
      AND lease_token = $3
      AND status = 'running'
      AND locked_until > NOW()
    RETURNING cancel_requested;
    `,
    [jobId, workerId, leaseToken, leaseSeconds]
  );

  if (result.rowCount === 0) {
    return { renewed: false, cancelRequested: false };
  }

  return {
    renewed: true,
    cancelRequested: result.rows[0].cancel_requested,
  };
}

export async function markJobCancelled(
  jobId: string,
  workerId: string,
  leaseToken: string
): Promise<boolean> {
  const result = await pool.query(
    `
    UPDATE jobs
    SET
      status = 'cancelled',
      locked_by = NULL,
      locked_until = NULL,
      lease_token = NULL,
      updated_at = NOW()
    WHERE id = $1
      AND locked_by = $2
      AND lease_token = $3
      AND status = 'running'
      AND locked_until > NOW()
      AND cancel_requested = TRUE;
    `,
    [jobId, workerId, leaseToken]
  );

  return (result.rowCount ?? 0) === 1;
}