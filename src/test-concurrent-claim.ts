import { claimJob } from "./jobs/job.repository.js";

async function main() {
  const [workerA, workerB] = await Promise.all([
    claimJob("worker-A"),
    claimJob("worker-B"),
  ]);

  console.log("Worker A claimed:", workerA?.id ?? null);
  console.log("Worker B claimed:", workerB?.id ?? null);
}

main().catch(console.error);