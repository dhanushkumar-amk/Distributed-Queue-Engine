import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";

async function verifyPhase28() {
  console.log("--- Verifying Phase 28: Multi-Queue Worker Support ---");

  try {
    await loadScripts(redis);
    const apiQueue = new Queue("api-responses", redis);
    const emailQueue = new Queue("email-notifications", redis);

    await redis.flushdb();

    const processedQueues: string[] = [];

    // Create a worker that listens to BOTH queues
    const worker = new Worker(["api-responses", "email-notifications"], async (job) => {
        console.log(`  [Worker] Processing ${job.name} from queue: ${job.queueName}`);
        processedQueues.push(job.queueName);
    }, redis, { concurrency: 2 });

    console.log("[Step 1] Adding jobs to both queues...");
    await apiQueue.add("API Request #1", { path: "/v1/users" });
    await apiQueue.add("API Request #2", { path: "/v1/orders" });
    await emailQueue.add("Welcome Email", { to: "user@example.com" });
    await emailQueue.add("Receipt Email", { amount: 99.99 });

    await worker.start();

    // Give it some time to process all 4 jobs
    console.log("Waiting for processing...");
    await new Promise(r => setTimeout(r, 4000));

    console.log(`Total jobs processed: ${processedQueues.length}`);
    console.log(`Processed queues: ${Array.from(new Set(processedQueues)).join(', ')}`);

    if (processedQueues.length < 4) {
        throw new Error(`Expected 4 jobs, but only processed ${processedQueues.length}.`);
    }

    const uniqueQueues = new Set(processedQueues);
    if (!uniqueQueues.has("api-responses") || !uniqueQueues.has("email-notifications")) {
        throw new Error(`Worker didn't process from BOTH queues. Found: ${Array.from(uniqueQueues)}`);
    }

    await worker.stop();
    console.log("✅ Multi-Queue Worker works correctly!");

  } catch (err: any) {
    console.error("❌ Phase 28 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 28 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase28();
