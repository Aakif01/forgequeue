
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { pool } from "../src/config/database.js";
import { registerClient } from "../src/clients/client.service.js";
import { recoverExpiredJobs } from "../src/jobs/job.repository.js";

describe("Worker process integration", () => {
  let clientId: string;
  let worker: ChildProcess | undefined;

  let jobId: string;

  beforeAll(async () => {
    const schema = await readFile(
      new URL("../src/database/schema.sql", import.meta.url),
      "utf8"
    );

    await pool.query(schema);

    const registered = await registerClient(
      `worker-test-${randomUUID()}`
    );

    clientId = registered.client.id;
  });

  afterAll(async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.kill("SIGTERM");

      await Promise.race([
        once(worker, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);

      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
      }
    }

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

    await pool.end();
  });

  it("executes a PostgreSQL job in a separate worker process", async () => {
    const inserted = await pool.query<{ id: string }>(
      `
      INSERT INTO jobs (
        client_id,
        type,
        payload,
        status,
        run_at,
        max_attempts,
        idempotency_key
      )
      VALUES ($1, $2, $3, 'pending', NOW(), 3, $4)
      RETURNING id;
      `,
      [
        clientId,
        "test.integration",
        JSON.stringify({ message: "hello worker" }),
        randomUUID(),
      ]
    );

    jobId = inserted.rows[0].id;

    worker = spawn(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/test-worker.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DB_NAME: "forgequeue_test",
          WORKER_ID: `integration-${randomUUID()}`,
        },
        stdio: "ignore",
      }
    );

    const deadline = Date.now() + 8000;
    let status = "pending";

    while (Date.now() < deadline) {
      const result = await pool.query<{ status: string }>(
        "SELECT status FROM jobs WHERE id = $1",
        [jobId]
      );

      status = result.rows[0]?.status ?? "missing";

      if (status === "completed") {
        break;
      }

      if (worker.exitCode !== null || worker.signalCode !== null) {
        throw new Error("Worker process exited unexpectedly");
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(status).toBe("completed");
  });

  it("records a handler failure and schedules a retry", async () => {
  const inserted = await pool.query<{ id: string }>(
    `
    INSERT INTO jobs (
      client_id,
      type,
      payload,
      status,
      run_at,
      max_attempts,
      idempotency_key
    )
    VALUES ($1, $2, $3, 'pending', NOW(), 3, $4)
    RETURNING id;
    `,
    [
      clientId,
      "test.integration.failure",
      JSON.stringify({ message: "fail deliberately" }),
      randomUUID(),
    ]
  );

  const failedJobId = inserted.rows[0].id;

  const deadline = Date.now() + 8000;

  let job:
    | { status: string; attempts: number; last_error: string | null }
    | undefined;

  while (Date.now() < deadline) {
    const result = await pool.query<{
      status: string;
      attempts: number;
      last_error: string | null;
    }>(
      `
      SELECT status, attempts, last_error
      FROM jobs
      WHERE id = $1;
      `,
      [failedJobId]
    );

    job = result.rows[0];

    if (job?.attempts === 1 && job.status === "pending") {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  expect(job?.status).toBe("pending");
  expect(job?.attempts).toBe(1);
  expect(job?.last_error).toBe(
    "Intentional integration test failure"
  );
});

  
it("recovers a job after a worker crashes and lets another worker complete it", async () => {
  // Stop the previous worker so it cannot steal this test's job.
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const exitPromise = once(worker, "exit");
    worker.kill("SIGTERM");
    await exitPromise;
  }

  worker = undefined;

  const crasherId = "integration-crasher";

  const inserted = await pool.query<{ id: string }>(
    `
    INSERT INTO jobs (
      client_id, type, payload, status,
      run_at, max_attempts, idempotency_key
    )
    VALUES ($1, 'test.integration.crash', $2, 'pending',
            NOW(), 3, $3)
    RETURNING id;
    `,
    [clientId, JSON.stringify({ test: "crash" }), randomUUID()]
  );

  const crashJobId = inserted.rows[0].id;

  // Prevent other pending jobs from interfering.
  await pool.query(
    `
    UPDATE jobs
    SET run_at = NOW() + INTERVAL '1 hour'
    WHERE client_id = $1
      AND id <> $2
      AND status = 'pending';
    `,
    [clientId, crashJobId]
  );

  // Start Worker A.
  worker = spawn(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/test-worker.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_NAME: "forgequeue_test",
        WORKER_ID: crasherId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let childPid: number | undefined;
let workerOutput = "";

worker.stdout?.on("data", (chunk: Buffer) => {
  workerOutput += chunk.toString();

  const match = workerOutput.match(/TEST_HANDLER_PID:(\d+)/);

  if (match) {
    childPid = Number(match[1]);
  }
});

  // Wait until Worker A owns the job.
  const claimDeadline = Date.now() + 8000;
  let claimed = false;

  while (Date.now() < claimDeadline) {
    const result = await pool.query(
      `
      SELECT id
      FROM jobs
      WHERE id = $1
        AND status = 'running'
        AND locked_by = $2;
      `,
      [crashJobId, crasherId]
    );

    if (result.rowCount === 1) {
      claimed = true;
      break;
    }

    if (worker.exitCode !== null || worker.signalCode !== null) {
      throw new Error("Worker A exited before claiming the job");
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  expect(claimed).toBe(true);

  const childDeadline = Date.now() + 5000;

while (!childPid && Date.now() < childDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

expect(childPid).toBeDefined();

  // Simulate a genuine process crash.
  const crashedWorker = worker;
  const exitPromise = once(crashedWorker, "exit");

  crashedWorker.kill("SIGKILL");
  await exitPromise;

  let childExited = false;
const childExitDeadline = Date.now() + 3000;

while (Date.now() < childExitDeadline) {
  try {
    process.kill(childPid!, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      childExited = true;
      break;
    }

    throw error;
  }

  await new Promise((resolve) => setTimeout(resolve, 50));
}

if (!childExited) {
  try {
    process.kill(childPid!, "SIGKILL");
  } catch {
    // Child may have exited during cleanup.
  }
}

expect(childExited).toBe(true);

  worker = undefined;

  // Simulate expiration of the crashed worker's lease.
  await pool.query(
    `
    UPDATE jobs
    SET locked_until = NOW() - INTERVAL '1 second'
    WHERE id = $1;
    `,
    [crashJobId]
  );

  // Recover the expired job.
  const recovered = await recoverExpiredJobs();

  expect(
    recovered.find((job) => job.id === crashJobId)?.status
  ).toBe("pending");

  // Skip retry backoff to keep the integration test fast.
  await pool.query(
    "UPDATE jobs SET run_at = NOW() WHERE id = $1",
    [crashJobId]
  );

  // Start Worker B.
  worker = spawn(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/test-worker.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_NAME: "forgequeue_test",
        WORKER_ID: "integration-recovery",
      },
      stdio: "ignore",
    }
  );

  const completionDeadline = Date.now() + 8000;
  let status = "pending";

  while (Date.now() < completionDeadline) {
    const result = await pool.query<{ status: string }>(
      "SELECT status FROM jobs WHERE id = $1",
      [crashJobId]
    );

    status = result.rows[0]?.status ?? "missing";

    if (status === "completed") {
      break;
    }

    if (worker.exitCode !== null || worker.signalCode !== null) {
      throw new Error("Worker B exited unexpectedly");
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  expect(status).toBe("completed");
});

  
it("finishes its active job before shutting down on SIGTERM", async () => {
  // Stop the worker left running by the previous test.
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const previousExit = once(worker, "exit");
    worker.kill("SIGTERM");
    await previousExit;
  }

  worker = undefined;

  const inserted = await pool.query<{ id: string }>(
    `
    INSERT INTO jobs (
      client_id, type, payload, status,
      run_at, max_attempts, idempotency_key
    )
    VALUES ($1, 'test.integration.graceful', $2, 'pending',
            NOW(), 3, $3)
    RETURNING id;
    `,
    [clientId, JSON.stringify({ test: "shutdown" }), randomUUID()]
  );

  const gracefulJobId = inserted.rows[0].id;

  await pool.query(
    `
    UPDATE jobs
    SET run_at = NOW() + INTERVAL '1 hour'
    WHERE client_id = $1
      AND id <> $2
      AND status = 'pending';
    `,
    [clientId, gracefulJobId]
  );

  worker = spawn(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/test-worker.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_NAME: "forgequeue_test",
        WORKER_ID: `integration-graceful-${randomUUID()}`,
      },
      stdio: "ignore",
    }
  );

  const claimDeadline = Date.now() + 8000;
  let claimed = false;

  while (Date.now() < claimDeadline) {
    const result = await pool.query(
      `
      SELECT id FROM jobs
      WHERE id = $1 AND status = 'running';
      `,
      [gracefulJobId]
    );

    if (result.rowCount === 1) {
      claimed = true;
      break;
    }

    if (worker.exitCode !== null || worker.signalCode !== null) {
      throw new Error("Worker exited before claiming the job");
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  expect(claimed).toBe(true);

  // Signal shutdown while the handler is still executing.
  const exitPromise = once(worker, "exit");
  worker.kill("SIGTERM");

  const [exitCode, signal] = await Promise.race([
    exitPromise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Worker did not shut down in time")),
        5000
      )
    ),
  ]) as [number | null, NodeJS.Signals | null];

  expect(signal).toBeNull();
  expect(exitCode).toBe(0);

  worker = undefined;

  const result = await pool.query<{ status: string }>(
    "SELECT status FROM jobs WHERE id = $1",
    [gracefulJobId]
  );

  expect(result.rows[0].status).toBe("completed");
});


it("detects a synchronous child that survives its parent crash", async () => {
  const inserted = await pool.query<{ id: string }>(
    `
    INSERT INTO jobs (
      client_id, type, payload, status,
      run_at, max_attempts, idempotency_key
    )
    VALUES ($1, 'test.integration.blocking', '{}', 'pending',
            NOW(), 3, $2)
    RETURNING id;
    `,
    [clientId, randomUUID()]
  );

  const blockingJobId = inserted.rows[0].id;

  const blockingWorker = spawn(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/test-worker.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_NAME: "forgequeue_test",
        WORKER_ID: `integration-blocking-${randomUUID()}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let output = "";
  let childPid: number | undefined;

  blockingWorker.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const match = output.match(/TEST_BLOCKING_PID:(\d+)/);
    if (match) childPid = Number(match[1]);
  });

  try {
    const deadline = Date.now() + 10000;

    while (!childPid && Date.now() < deadline) {
      if (blockingWorker.exitCode !== null || blockingWorker.signalCode !== null) {
        throw new Error(`Blocking worker exited early: ${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(childPid).toBeDefined();

    const workerExit = once(blockingWorker, "exit");
    blockingWorker.kill("SIGKILL");
    await workerExit;

    await new Promise((resolve) => setTimeout(resolve, 500));

    let childAlive = false;

    try {
      process.kill(childPid!, 0);
      childAlive = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }

    // This is the behavior under investigation.
    expect(childAlive).toBe(false);
  } finally {
    if (blockingWorker.exitCode === null && blockingWorker.signalCode === null) {
      blockingWorker.kill("SIGKILL");
    }

    if (childPid !== undefined) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
  }
});

});
