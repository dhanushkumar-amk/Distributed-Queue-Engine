import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";

async function verifyPhase27() {
  console.log("--- Verifying Phase 27: Distributed Rate Limiting ---");

  try {
    await loadScripts(redis);
    const queueName = "rate-limit-test-queue";
    const queue = new Queue(queueName, redis);

    await redis.flushdb();

    const processedTimes: number[] = [];

    // Limit: Max 2 jobs per 5 seconds
    const worker = new Worker(queueName, async (job) => {
        const now = Date.now();
        console.log(`  [Worker] Processed job ${job.id} at ${now}`);
        processedTimes.push(now);
    }, redis, { 
        concurrency: 1, 
        rateLimit: { max: 2, durationMs: 5000 } 
    });

    console.log("[Step 1] Adding 5 jobs to a rate-limited queue...");
    for (let i = 1; i <= 5; i++) {
        await queue.add(`job-${i}`, { i });
    }

    await worker.start();

    // Wait for initial batch (should be 2)
    console.log("Waiting 2 seconds for initial batch...");
    await new Promise(r => setTimeout(r, 2000));

    console.log(`Jobs processed so far: ${processedTimes.length}`);
    if (processedTimes.length > 2) {
        throw new Error(`Rate limit exceeded! Processed ${processedTimes.length} jobs, expected <= 2.`);
    }

    // Wait for the next window
    console.log("Waiting 4 more seconds for next window...");
    await new Promise(r => setTimeout(r, 4500));

    console.log(`Jobs processed after window: ${processedTimes.length}`);
    if (processedTimes.length <= 2) {
        throw new Error("Worker failed to resume after rate limit window.");
    }

    await worker.stop();
    console.log("✅ Rate limiting works correctly!");

  } catch (err: any) {
    console.error("❌ Phase 27 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 27 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase27();
