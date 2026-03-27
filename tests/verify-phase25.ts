import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";

async function verifyPhase25() {
  console.log("--- Verifying Phase 25: Job Cancellation ---");

  try {
    await loadScripts(redis);
    const queueName = "cancel-test-queue";
    const queue = new Queue(queueName, redis);

    await redis.flushdb();

    // 1. Test Cancellation of Waiting Job
    console.log("[Step 1] Testing cancellation of a waiting job...");
    const job1 = await queue.add("waiting-task", {});
    let metrics = await queue.getMetrics();
    console.log("Before Cancel:", { waiting: metrics.waiting, cancelled: metrics.cancelled });

    await queue.cancel(job1.id);
    metrics = await queue.getMetrics();
    console.log("After Cancel: ", { waiting: metrics.waiting, cancelled: metrics.cancelled });

    if (metrics.waiting !== 0 || metrics.cancelled !== 1) {
        throw new Error("Waiting job cancellation failed!");
    }

    // 2. Test In-Flight Cancellation
    console.log("\n[Step 2] Testing in-flight cancellation...");
    let wasCancelledDetected = false;

    const worker = new Worker(queueName, async (job) => {
        console.log("  [Worker] Starting long task...");
        for (let i = 0; i < 20; i++) {
           await new Promise(r => setTimeout(r, 200));
           if (job.isCancelled!()) {
               console.log("  [Worker] Cancellation detected! Stopping...");
               wasCancelledDetected = true;
               return;
           }
        }
    }, redis);

    await worker.start();

    const job2 = await queue.add("active-task", {});
    
    // Give it a moment to become active
    await new Promise(r => setTimeout(r, 1000));
    
    console.log(`[Queue] Cancelling active job: ${job2.id}`);
    const cancelResult = await queue.cancel(job2.id);
    console.log(`[Queue] Cancel Result: ${cancelResult}`);

    // Wait for worker to detect it
    await new Promise(r => setTimeout(r, 3000));

    if (wasCancelledDetected) {
        console.log("✅ In-flight cancellation successful!");
    } else {
        throw new Error("Worker failed to detect cancellation!");
    }

    await worker.stop();

  } catch (err: any) {
    console.error("❌ Phase 25 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 25 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase25();
