import { claimJob, renewLease } from "./jobs/job.repository.js";
import { pool } from "./config/database.js";

async function main() {
  try {
    const job = await claimJob("heartbeat-test", 30);

    if (!job || !job.lease_token) {
      console.log("No eligible job available");
      return;
    }

    console.log("Initial lease:", job.locked_until);

    const renewed = await renewLease(
      job.id,
      "heartbeat-test",
      job.lease_token,
      30
    );

    console.log("Lease renewed:", renewed);

    const result = await pool.query(
      `SELECT locked_until FROM jobs WHERE id = $1`,
      [job.id]
    );

    console.log("New lease expiration:", result.rows[0].locked_until);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);