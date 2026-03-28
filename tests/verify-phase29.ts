import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";

async function verifyPhase29() {
  console.log("--- Verifying Phase 29: Auto-Cleanup & Job TTL ---");

  try {
    await loadScripts(redis);
    const queueName = "cleanup-test-queue";
    const queue = new Queue(queueName, redis);
    await redis.flushdb();

    // Step 1: Add 10 jobs and process them all
    console.log("[Step 1] Adding and processing 10 jobs...");
    const worker = new Worker(queueName, async (_job) => {
      // Fast processor - just complete immediately
    }, redis, { concurrency: 5 });

    for (let i = 1; i <= 10; i++) {
      await queue.add(`job-${i}`, { i });
    }

    await worker.start();
    await new Promise(r => setTimeout(r, 3000)); // Wait for all jobs to complete
    await worker.stop();

    const before = await queue.getMetrics();
    console.log(`Before cleanup — completed: ${before.completed}`);
    if (before.completed < 8) {
      throw new Error(`Expected at least 8 completed jobs, got ${before.completed}`);
    }

    // Step 2: Run cleanup with maxCount = 3 (keep only 3 most recent)
    console.log("\n[Step 2] Running cleanup with maxCount=3...");
    const result = await queue.runCleanup({ maxCount: 3 });
    console.log(`Cleanup result: ${JSON.stringify(result)}`);

    const afterCount = await queue.getMetrics();
    console.log(`After maxCount cleanup — completed: ${afterCount.completed}`);
    if (afterCount.completed > 3) {
      throw new Error(`Expected <= 3 completed jobs after cleanup, got ${afterCount.completed}`);
    }
    console.log("✅ maxCount cleanup works!");

    // Step 3: Run cleanup with maxAge = 1ms (should delete everything since all jobs are older)
    console.log("\n[Step 3] Running cleanup with maxAge=1ms (wipe everything)...");
    await new Promise(r => setTimeout(r, 10)); // ensure all are older than 1ms
    const result2 = await queue.runCleanup({ maxAge: 1 });
    console.log(`Cleanup result: ${JSON.stringify(result2)}`);

    const afterAge = await queue.getMetrics();
    console.log(`After maxAge cleanup — completed: ${afterAge.completed}`);
    if (afterAge.completed > 0) {
      throw new Error(`Expected 0 completed jobs after maxAge cleanup, got ${afterAge.completed}`);
    }
    console.log("✅ maxAge cleanup works!");

    // Step 4: Verify auto-cleanup timer works
    console.log("\n[Step 4] Testing auto-cleanup timer...");
    for (let i = 1; i <= 5; i++) {
      await queue.add(`timer-job-${i}`, { i });
    }
    const worker2 = new Worker(queueName, async (_job) => {}, redis, { concurrency: 5 });
    await worker2.start();
    await new Promise(r => setTimeout(r, 2000));
    await worker2.stop();

    let timerFired = false;
    queue.on('cleaned', () => { timerFired = true; });

    queue.startCleanup({ maxCount: 1, intervalMs: 500 }); // fire every 500ms
    await new Promise(r => setTimeout(r, 1200));
    queue.stopCleanup();

    if (!timerFired) {
      throw new Error("Auto-cleanup timer did not fire the 'cleaned' event.");
    }
    console.log("✅ Auto-cleanup timer works!");

  } catch (err: any) {
    console.error("❌ Phase 29 Failed:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 29 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase29();
