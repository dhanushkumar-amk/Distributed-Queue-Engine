import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";
import { JobStatus } from "../src/types";

async function verifyPhase19() {
  console.log("--- Verifying Phase 19: Advanced Backoff Strategy ---");

  try {
    await loadScripts(redis);
    const queueName = "notification-queue";
    const queue = new Queue(queueName, redis);

    await redis.flushdb();

    const attemptTimes: number[] = [];

    const processor = async (job: any) => {
       attemptTimes.push(Date.now());
       console.log(`📡 Sending notification... (Attempt ${attemptTimes.length})`);
       throw new Error("Downstream Service Unavailable!");
    };

    const worker = new Worker(queueName, processor, redis);
    await worker.start();

    // 1. Add job with exponential backoff (1s initial delay)
    console.log("\n[Step 1] Adding job with exponential backoff (1s)...");
    const job = await queue.add("sms-notify", { phone: "123" }, { 
        attempts: 3, 
        backoff: { type: "exponential", delay: 1000 } 
    });

    // 2. Wait for final failure (3 attempts total)
    console.log("⏳ Waiting for 3 attempts...");
    
    let iterations = 0;
    while (iterations < 20) {
       const j = await queue.getJob(job.id);
       if (j?.status === JobStatus.FAILED) break;
       iterations++;
       await new Promise(r => setTimeout(r, 1000));
    }

    // 3. Analyze times
    console.log("\n[Step 2] Analyzing timing gaps...");
    if (attemptTimes.length === 3) {
        const gap1 = (attemptTimes[1] - attemptTimes[0]) / 1000;
        const gap2 = (attemptTimes[2] - attemptTimes[1]) / 1000;
        
        console.log(`   Gap 1 (Retry 1): ${gap1.toFixed(2)}s (Expected ~1s)`);
        console.log(`   Gap 2 (Retry 2): ${gap2.toFixed(2)}s (Expected ~2s)`);

        if (gap2 > gap1 && gap1 >= 0.9 && gap2 >= 1.9) {
            console.log("✅ Exponential backoff verified! Gaps are increasing correctly.");
        } else {
            console.error("❌ Gaps did not show exponential growth!");
            process.exit(1);
        }
    } else {
        console.error(`❌ Expected 3 attempts, got ${attemptTimes.length}`);
        process.exit(1);
    }

    await worker.stop();

  } catch (err: any) {
    console.error("❌ Phase 19 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 19 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase19();
