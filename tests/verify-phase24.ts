import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";

async function verifyPhase24() {
  console.log("--- Verifying Phase 24: Job Progress Tracking ---");

  try {
    await loadScripts(redis);
    const queueName = "progress-test-queue";
    const queue = new Queue(queueName, redis);

    await redis.flushdb();

    let capturedProgress = 0;

    const worker = new Worker(queueName, async (job) => {
        console.log("  [Step 1] Reporting 50% progress...");
        await job.updateProgress!(50);
        await new Promise(r => setTimeout(r, 500));
        console.log("  [Step 2] Reporting 100% progress...");
        await job.updateProgress!(100);
    }, redis);

    worker.on("progress", (job, progress) => {
        console.log(`  🔔 Event: Worker PROGRESS for ${job.id}: ${progress}%`);
        capturedProgress = progress;
    });

    await worker.start();

    const job = await queue.add("progress-task", {});
    
    // Wait for completion
    let attempts = 0;
    while (attempts < 10) {
        const check = await queue.getJob(job.id);
        if (check && check.completedAt) break;
        attempts++;
        await new Promise(r => setTimeout(r, 500));
    }

    // Verify final state in Redis
    const finalJob = await queue.getJob(job.id);
    console.log(`Final Job Progress in Redis: ${finalJob?.progress}%`);

    if (capturedProgress === 100 && finalJob?.progress === 100) {
        console.log("✅ Progress tracking verified!");
    } else {
        throw new Error(`Progress tracking failed! Captured: ${capturedProgress}, Redis: ${finalJob?.progress}`);
    }

    await worker.stop();

  } catch (err: any) {
    console.error("❌ Phase 24 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 24 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase24();
