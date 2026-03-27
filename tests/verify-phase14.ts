import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";

async function verifyPhase14() {
  console.log("--- Verifying Phase 14: Delayed Jobs (runAt Score) ---");

  try {
    // 1. Initial Setup
    await loadScripts(redis);
    const queueName = "image-resizer";
    const queue = new Queue(queueName, redis);

    // Ensure state clean before test
    await redis.flushdb();

    // --- TEST 1: Delayed Job Behavior ---
    console.log("\n[Scenario 1] Adding a job with 2s delay...");
    const delayMs = 2000;
    const delayedJob = await queue.add("resize-main-banner", { width: 800 }, { delay: delayMs });

    console.log(`Current Time: ${new Date().toLocaleTimeString()}`);
    console.log(`Job scheduled for: ${new Date(delayedJob.runAt).toLocaleTimeString()}`);

    // Check if it's in the waiting list immediately
    const waitingBefore = await queue.getWaitingJobsIds();
    console.log(`Waiting jobs (score <= now): ${waitingBefore.length}`);
    
    if (waitingBefore.length !== 0) {
      console.error("❌ Job should NOT be ready yet!");
      process.exit(1);
    }

    // Check if it's in delayed jobs
    const delayedJobs = await queue.getDelayedJobs();
    if (delayedJobs.includes(delayedJob.id)) {
      console.log("✅ Job is correctly in the 'delayed' category!");
    } else {
      console.error("❌ Job NOT found in delayed list!");
      process.exit(1);
    }

    // Wait and check again
    console.log(`⏳ Waiting for ${delayMs}ms...`);
    await new Promise(resolve => setTimeout(resolve, delayMs + 100)); // Buffer of 100ms

    const waitingAfter = await queue.getWaitingJobsIds();
    console.log(`Waiting jobs (score <= now): ${waitingAfter.length}`);
    console.log(`Current Time: ${new Date().toLocaleTimeString()}`);

    if (waitingAfter.includes(delayedJob.id)) {
      console.log("✅ Success! Job is now marked as ready (delayed promotion verified)!");
    } else {
      console.error("❌ Job still not ready after waiting!");
      process.exit(1);
    }

    // --- TEST 2: High-Level API (Queue.add) ---
    console.log("\n[Scenario 2] Adding an immediate job...");
    const immediateJob = await queue.add("send-welcome-email", { email: "user@example.com" });

    const waitingImmediate = await queue.getWaitingJobsIds();
    if (waitingImmediate.includes(immediateJob.id)) {
      console.log("✅ Immediate job enqueued and ready successfully!");
    } else {
      console.error("❌ Immediate job failed to show up in waiting list!");
      process.exit(1);
    }

    // --- TEST 3: Dequeuing with updated signature ---
    console.log("\n[Scenario 3] Dequeuing a job with timestamp...");
    // dequeue(3, waitingKey, activeKey, jobKeyPrefix, now)
    // We already moved waitingKey to a Sorted Set in dequeue.lua
    // Let's use the redis.dequeue method directly for verification
    const jkPrefix = `queue:${queueName}:jobs:`;
    const wk = `queue:${queueName}:waiting`;
    const ak = `queue:${queueName}:active`;

    const pickedId = await redis.moveToActive(3, wk, ak, jkPrefix, Date.now());
    
    if (pickedId) {
      console.log(`✅ Successfully dequeued Job ID: ${pickedId}`);
    } else {
      console.error("❌ Dequeue returned nil even though jobs were ready!");
      process.exit(1);
    }

  } catch (err: any) {
    console.error("❌ Phase 14 Development Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 14 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase14();
