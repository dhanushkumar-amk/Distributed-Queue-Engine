import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";
import { JobStatus } from "../src/types";

async function verifyPhase18() {
  console.log("--- Verifying Phase 18: Job Retries & Error Handling ---");

  try {
    await loadScripts(redis);
    const queueName = "payment-gateway";
    const queue = new Queue(queueName, redis);

    await redis.flushdb();

    let processAttempts = 0;

    // 1. Define Processor that fails
    const processor = async (job: any) => {
       processAttempts++;
       console.log(`💳 Attempt ${processAttempts} to process ${job.name}...`);
       throw new Error("Temporary Connection Timeout!");
    };

    const worker = new Worker(queueName, processor, redis);
    await worker.start();

    // 2. Add job with maxAttempts = 2
    console.log("\n[Step 1] Adding job with 2 max attempts...");
    const initialJob = await queue.add("pay-invoice", { amount: 100 }, { attempts: 2 });

    // 3. Wait for the cycle (1st fail -> WAITING -> 2nd fail -> FAILED)
    console.log("⏳ Processing and retrying... (Expecting 2 attempts total)");
    
    let attempts = 0;
    while (attempts < 15) {
       const job = await queue.getJob(initialJob.id);
       
       console.log(`   Job Status: ${job?.status}, Attempts Made: ${job?.attempts}`);
       
       if (job?.status === JobStatus.FAILED) {
           console.log("✅ Final status is FAILED as expected.");
           break;
       }
       attempts++;
       await new Promise(r => setTimeout(r, 1000));
    }

    if (processAttempts === 2) {
        console.log("✅ Worker executed the job exactly 2 times!");
    } else {
        console.error(`❌ Expected 2 processor runs, got ${processAttempts}`);
        process.exit(1);
    }

    await worker.stop();

  } catch (err: any) {
    console.error("❌ Phase 18 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 18 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase18();
