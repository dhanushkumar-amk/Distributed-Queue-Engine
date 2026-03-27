import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";

async function verifyPhase21() {
  console.log("--- Verifying Phase 21: Logging & Event Dispatching ---");

  try {
    await loadScripts(redis);
    const queueName = "event-test-queue";
    const queue = new Queue(queueName, redis);

    await redis.flushdb();

    const events: string[] = [];

    // 1. Attach listeners
    queue.on("waiting", (job) => {
        events.push(`queue:waiting:${job.id}`);
        console.log(`  🔔 Event: Queue WAITING for ${job.id}`);
    });

    const processor = async (job: any) => {
       if (job.name === "fail") throw new Error("Boom");
       return { processed: true };
    };

    const worker = new Worker(queueName, processor, redis);

    worker.on("active", (job) => {
        events.push(`worker:active:${job.id}`);
        console.log(`  🔔 Event: Worker ACTIVE for ${job.id}`);
    });

    worker.on("completed", (job, result) => {
        events.push(`worker:completed:${job.id}`);
        console.log(`  🔔 Event: Worker COMPLETED for ${job.id} with result:`, result);
    });

    worker.on("failed", (job, err) => {
        events.push(`worker:failed:${job.id}`);
        console.log(`  🔔 Event: Worker FAILED for ${job.id} - ${err.message}`);
    });

    await worker.start();

    // 2. Trigger events
    console.log("\n[Step 1] Triggering success life cycle...");
    const job1 = await queue.add("success", { x: 1 });
    
    // 3. Trigger failure event
    console.log("\n[Step 2] Triggering failure life cycle...");
    const job2 = await queue.add("fail", { x: 2 }, { attempts: 1 });

    // 4. Wait for all events to settle
    console.log("\n⏳ Waiting for events...");
    let attempts = 0;
    while (attempts < 10 && events.length < 6) {
        attempts++;
        await new Promise(r => setTimeout(r, 800));
    }

    console.log("\n[Step 3] Final Event List:", events);

    const expected = [
        `queue:waiting:${job1.id}`,
        `queue:waiting:${job2.id}`,
        `worker:active:${job1.id}`,
        `worker:completed:${job1.id}`,
        `worker:active:${job2.id}`,
        `worker:failed:${job2.id}`
    ];

    const missing = expected.filter(e => !events.includes(e));

    if (missing.length === 0) {
        console.log("✅ All events fired successfully!");
    } else {
        console.error("❌ Missing events:", missing);
        process.exit(1);
    }

    await worker.stop();

  } catch (err: any) {
    console.error("❌ Phase 21 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 21 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase21();
