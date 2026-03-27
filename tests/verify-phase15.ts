import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { jobKey, activeKey } from "../src/keys";

async function verifyPhase15() {
  console.log("--- Verifying Phase 15: Atomic Job Pickup (moveToActive.lua) ---");

  try {
    // 1. Initial Setup
    await loadScripts(redis);
    const queueName = "video-processing";
    const queue = new Queue(queueName, redis);

    // Ensure state clean before test
    await redis.flushdb();

    // --- TEST 1: The Move to Active Hash ---
    console.log("\n[Scenario 1] Picking up a job...");
    const job = await queue.add("compress-mp4", { file: "vacation.mov" });
    const now = Date.now();
    
    const jk = jobKey(queueName, job.id);
    const ak = activeKey(queueName);
    const jkPrefix = `queue:${queueName}:jobs:`;
    const wk = `queue:${queueName}:waiting`;

    // Move to active
    const pickedId = await redis.moveToActive(3, wk, ak, jkPrefix, now);

    if (pickedId === job.id) {
       console.log(`✅ Job ${pickedId} picked up successfully!`);
    } else {
       console.error(`❌ Dequeue failed or returned wrong ID: ${pickedId}`);
       process.exit(1);
    }

    // A. Verify job metadata
    const jobData = await redis.hgetall(jk);
    if (jobData.status === "active" && jobData.heartbeatAt === String(now)) {
       console.log("✅ Job metadata updated with status='active' and heartbeatAt!");
    } else {
       console.error(`❌ Metadata mismatch: status=${jobData.status}, heartbeatAt=${jobData.heartbeatAt}`);
       process.exit(1);
    }

    // B. Verify active HASH
    const activeVal = await redis.hget(ak, job.id);
    if (activeVal === String(now)) {
        console.log(`✅ Job ID ${job.id} registered in the ACTIVE HASH with heartbeat value!`);
    } else {
        console.error(`❌ Active hash wrong! Expected ${now}, got ${activeVal}`);
        process.exit(1);
    }

    // --- TEST 2: Completion cleanup ---
    console.log("\n[Scenario 2] Completing the job...");
    const ck = `queue:${queueName}:completed`;
    await redis.complete(3, jk, ak, ck, job.id);

    const activeAfter = await redis.hget(ak, job.id);
    const finalStatus = await redis.hget(jk, "status");

    if (activeAfter === null && finalStatus === "completed") {
        console.log("✅ HDEL cleaned up the active hash correctly!");
    } else {
        console.error(`❌ Cleanup failed! activeVal=${activeAfter}, status=${finalStatus}`);
        process.exit(1);
    }

  } catch (err: any) {
    console.error("❌ Phase 15 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 15 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase15();
