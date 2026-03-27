import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";

async function verifyPhase16() {
  console.log("--- Verifying Phase 16: Worker Class Foundation ---");

  try {
    // 1. Setup
    await loadScripts(redis);
    const queueName = "email-verification";
    const queue = new Queue(queueName, redis);

    // Ensure state clean before test
    await redis.flushdb();

    // 2. Enqueue 3 jobs (2 success, 1 failure)
    console.log("\n[Step 1] Enqueuing 3 jobs...");
    await queue.add("verify-email", { email: "alice@example.com" });
    await queue.add("verify-email", { email: "bob@example.com" });
    await queue.add("FAIL-ME", { email: "bad@example.com" }); // Will throw in processor

    let processedCount = 0;
    let failedCount = 0;

    // 3. Define Processor
    const processor = async (job: any) => {
      console.log(`👷 Processor working on ${job.name}...`);
      if (job.name === "FAIL-ME") {
        throw new Error("Job intentional failure!");
      }
      processedCount++;
    };

    // 4. Start Worker
    console.log("\n[Step 2] Starting Worker...");
    const worker = new Worker(queueName, processor, redis, { concurrency: 1, pollInterval: 500 });
    await worker.start();

    // 5. Wait for all jobs to reach final state
    console.log("⏳ Waiting for tasks to complete...");
    
    // Check for 3 total final states (completed + failed)
    const ck = `queue:${queueName}:completed`;
    const fk = `queue:${queueName}:failed`;
    const ak = `queue:${queueName}:active`;

    let attempts = 0;
    while (attempts < 20) {
       const completedLen = await redis.llen(ck);
       const failedLen = await redis.llen(fk);
       const activeLen = await redis.hlen(ak);

       console.log(`   Stats: Completed=${completedLen}, Failed=${failedLen}, Active=${activeLen}`);

       if (completedLen + failedLen === 3 && activeLen === 0) {
           console.log("✅ All jobs reached terminal states!");
           failedCount = failedLen;
           break;
       }
       attempts++;
       await new Promise(resolve => setTimeout(resolve, 800));
    }

    // Assertions
    if (processedCount === 2 && failedCount === 1) {
       console.log("✅ Worker correctly handled success/failure mix!");
    } else {
       console.error(`❌ Unexpected result: processed=${processedCount}, failed=${failedCount}`);
       process.exit(1);
    }

    // 6. Test Graceful Shutdown
    console.log("\n[Step 3] Stopping worker...");
    await worker.stop();

  } catch (err: any) {
    console.error("❌ Phase 16 Development Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 16 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase16();
