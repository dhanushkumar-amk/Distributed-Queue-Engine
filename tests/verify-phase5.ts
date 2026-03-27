import { createJob, JobStatus } from "../src/types";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
  console.log(`✅ ${message}`);
}

async function verifyPhase5() {
  console.log("--- Verifying Phase 5: Job Schema & Types ---");

  const data = { email: "test@example.com" };
  const job = createJob("job-1", "test-job", data, { attempts: 5 });

  assert(job.id === "job-1", "JobID matches");
  assert(job.name === "test-job", "JobName matches");
  assert(job.maxAttempts === 5, "MaxAttempts matches");
  assert(job.status === JobStatus.WAITING, "Status is WAITING");
  assert(job.data.email === "test@example.com", "Data content matches");

  const delayedJob = createJob("job-delayed", "test", {}, { delay: 1000 });
  assert(delayedJob.status === JobStatus.DELAYED, "Status is DELAYED for delayed jobs");
  assert(delayedJob.runAt > Date.now() + 500, "runAt is set for the future");

  console.log("--- Phase 5 Verification Passed ---");
}

verifyPhase5().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
