import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";
import { JobStatus } from "../src/types";

async function verifyPhase17() {
  console.log("--- Verifying Phase 17: Job Completion History (Sorted Sets) ---");

  try {
    // 1. Setup
    await loadScripts(redis);
    const queueName = "image-processor";
    const queue = new Queue(queueName, redis);

    // Ensure state clean before test
    await redis.flushdb();

    // 2. Define Worker
    const processor = async (job: any) => {
       console.log(`📸 Processing ${job.name}...`);
       // Minimal delay to ensure different completedAt scores
       await new Promise(r => setTimeout(r, 100));
    };
    const worker = new Worker(queueName, processor, redis);
    await worker.start();

    // 3. Add 3 jobs
    console.log("\n[Step 1] Adding 3 image tasks...");
    await queue.add("Avatar", { userId: 1 });
    await queue.add("Profile", { userId: 2 });
    await queue.add("Cover", { userId: 3 });

    // 4. Wait for processing
    console.log("⏳ Processing...");
    let attempts = 0;
    while (attempts < 10) {
       const count = await queue.getCompletedCount();
       if (count === 3) break;
       attempts++;
       await new Promise(r => setTimeout(r, 500));
    }

    // 5. Verify History Order (Most Recent First)
    console.log("\n[Step 2] Verifying Completed History...");
    const history = await queue.getCompletedJobs(3);
    console.log("Completed IDs (Most Recent First):", history);

    if (history.length === 3) {
        console.log("✅ History size is correct!");
    } else {
        console.error(`❌ Expected 3 items, got ${history.length}`);
        process.exit(1);
    }

    // Verify metadata of the first one
    const latestJob = await queue.getJob(history[0]);
    if (latestJob && latestJob.status === JobStatus.COMPLETED && latestJob.completedAt) {
        console.log(`✅ Latest Job metadata verified! Completed at: ${new Date(latestJob.completedAt).toLocaleTimeString()}`);
    } else {
        console.error("❌ Metadata missing or status incorrect!");
        process.exit(1);
    }

    await worker.stop();

  } catch (err: any) {
    console.error("❌ Phase 17 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 17 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase17();
