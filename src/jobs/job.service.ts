
import { pool } from "../config/database.js";
import type { Job } from "./job.repository.js";
import { isDeepStrictEqual } from "node:util";

interface SubmitJobInput {
  clientId: string;
  type: string;
  payload: unknown;
  idempotencyKey: string;
}

export async function submitJob(
  input: SubmitJobInput
): Promise<{ job: Job; created: boolean }> {
  const { clientId, type, payload, idempotencyKey } = input;

  if (!type.trim()) {
    throw new Error("Job type cannot be empty");
  }

  if (!idempotencyKey.trim()) {
    throw new Error("Idempotency key cannot be empty");
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error("Job payload must be a JSON object");
  }

  const result = await pool.query<Job>(
    `INSERT INTO jobs (
       client_id,
       type,
       payload,
       idempotency_key
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id, idempotency_key)
     DO NOTHING
     RETURNING *`,
    [clientId, type, JSON.stringify(payload), idempotencyKey]
  );

  if (result.rows.length > 0) {
    return {
      job: result.rows[0],
      created: true,
    };
  }

  const existing = await pool.query<Job>(
    `SELECT *
     FROM jobs
     WHERE client_id = $1
     AND idempotency_key = $2`,
    [clientId, idempotencyKey]
  );

  if (existing.rows.length === 0) {
    throw new Error("Unable to retrieve existing job");
  }

  const existingJob = existing.rows[0];

  const sameRequest =
  existingJob.type === type &&
  isDeepStrictEqual(existingJob.payload, payload);

  if (!sameRequest) {
    throw new Error(
      "Idempotency key already used with a different request"
    );
  }

  return {
    job: existingJob,
    created: false,
  };
}


export async function getJob(
  jobId: string,
  clientId: string
): Promise<Job | null> {
  const result = await pool.query<Job>(
    `SELECT *
     FROM jobs
     WHERE id = $1
     AND client_id = $2`,
    [jobId, clientId]
  );

  return result.rows[0] ?? null;
}


export async function cancelJob(
  jobId: string,
  clientId: string
): Promise<{
  job: Job | null;
  cancelled: boolean;
}> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET status = 'cancelled',
         updated_at = NOW()
     WHERE id = $1
       AND client_id = $2
       AND status = 'pending'
     RETURNING *`,
    [jobId, clientId]
  );

  if (result.rows.length > 0) {
    return {
      job: result.rows[0],
      cancelled: true,
    };
  }

  const existing = await getJob(jobId, clientId);

  return {
    job: existing,
    cancelled: false,
  };
}

export async function requestJobCancellation(
  jobId: string,
  clientId: string
): Promise<Job | null> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET cancel_requested = TRUE,
         updated_at = NOW()
     WHERE id = $1
       AND client_id = $2
       AND status = 'running'
     RETURNING *`,
    [jobId, clientId]
  );

  return result.rows[0] ?? null;
}