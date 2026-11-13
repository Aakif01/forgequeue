import { claimJob } from "./jobs/job.repository.js";

async function main() {
  const job = await claimJob("worker-01");

  console.log("Claimed job:", job);
}

main().catch(console.error);