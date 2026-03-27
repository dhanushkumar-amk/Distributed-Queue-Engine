import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";

async function verifyPhase26() {
  console.log("--- Verifying Phase 26: Priority Queuing ---");

  try {
    await loadScripts(redis);
    const queueName = "priority-test-queue";
    const queue = new Queue(queueName, redis);

    await redis.flushdb();

    const processedOrder: string[] = [];

    const worker = new Worker(queueName, async (job) => {
        console.log(`  [Worker] Processing: ${job.name} (Priority: ${job.priority})`);
        processedOrder.push(job.priority);
        await new Promise(r => setTimeout(r, 100));
    }, redis, { concurrency: 1 });

    // 1. Add multiple jobs with different priorities
    console.log("[Step 1] Adding jobs with different priorities...");
    await queue.add("low-task", {}, { priority: "low" });
    await queue.add("high-task", {}, { priority: "high" });
    await queue.add("normal-task", {}, { priority: "normal" });

    // Start worker
    await worker.start();

    // Wait for all 3 to process
    await new Promise(r => setTimeout(r, 1500));

    console.log("Processed Order:", processedOrder);

    if (processedOrder[0] !== "high" || processedOrder[1] !== "normal" || processedOrder[2] !== "low") {
        throw new Error("Priority order incorrect!");
    }
    console.log("✅ Basic priority sorting works!");

    // 2. Test Priority + Delay
    console.log("\n[Step 2] Testing Priority with Delay...");
    processedOrder.length = 0; // reset

    // Add a high priority job delayed by 2 seconds
    await queue.add("delayed-high", {}, { priority: "high", delay: 2000 });
    // Add a normal priority job ready now
    await queue.add("immediate-normal", {}, { priority: "normal" });

    // Wait for immediate one
    await new Promise(r => setTimeout(r, 500));
    console.log("After 0.5s, Processed:", processedOrder); // Should be ['normal']

    // Wait for delayed one
    await new Promise(r => setTimeout(r, 2000));
    console.log("After 2.5s, Processed:", processedOrder); // Should be ['normal', 'high']

    if (processedOrder[0] === "normal" && processedOrder[1] === "high") {
        console.log("✅ Priority with Delay works!");
    } else {
        throw new Error("Delay priority order incorrect!");
    }

    await worker.stop();

  } catch (err: any) {
    console.error("❌ Phase 26 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 26 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase26();
