import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";
import { JobStatus } from "../src/types";

async function verifyPhase20() {
  console.log("--- Verifying Phase 20: Queue Metrics & Monitoring ---");

  try {
    await loadScripts(redis);
    const queueName = "metrics-test-queue";
    const queue = new Queue(queueName, redis);

    await redis.flushdb();

    // 1. Initial State
    console.log("[Step 1] Verifying initial metrics (empty)...");
    let metrics = await queue.getMetrics();
    console.log("Initial Metrics:", metrics);
    if (metrics.waiting !== 0 || metrics.completed !== 0) {
        throw new Error("Initial metrics should be 0");
    }

    // 2. Add 5 jobs
    console.log("\n[Step 2] Adding 5 jobs...");
    for (let i = 0; i < 5; i++) {
        await queue.add("test-task", { i });
    }
    
    metrics = await queue.getMetrics();
    console.log("Post-Add Metrics:", metrics);
    if (metrics.waiting !== 5) {
        throw new Error(`Expected 5 waiting jobs, got ${metrics.waiting}`);
    }

    // 3. Process jobs
    console.log("\n[Step 3] Processing jobs...");
    const worker = new Worker(queueName, async () => {}, redis);
    await worker.start();

    // Wait for completion
    let attempts = 0;
    while (attempts < 10) {
        const m = await queue.getMetrics();
        if (m.completed === 5) {
            console.log("All jobs completed!");
            break;
        }
        attempts++;
        await new Promise(r => setTimeout(r, 500));
    }

    metrics = await queue.getMetrics();
    console.log("Post-Process Metrics:", metrics);

    // 4. Test Clean
    console.log("\n[Step 4] Testing Clean History...");
    // Clean with gracePeriod = 0 (everything)
    const cleanedCount = await queue.clean(JobStatus.COMPLETED, 0);
    console.log(`Cleaned ${cleanedCount} jobs from history.`);
    
    metrics = await queue.getMetrics();
    console.log("Final Metrics:", metrics);

    if (metrics.completed === 0) {
        console.log("✅ Metrics and Clean functionality verified!");
    } else {
        console.error("❌ Failed to clean completed history!");
        process.exit(1);
    }

    await worker.stop();

  } catch (err: any) {
    console.error("❌ Phase 20 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 20 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase20();
