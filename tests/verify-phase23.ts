import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { activeKey } from "../src/keys";

async function verifyPhase23() {
  console.log("--- Verifying Phase 23: Stall Detection & Auto-Recovery ---");

  try {
    await loadScripts(redis);
    const queueName = "watchdog-test-queue";
    const queue = new Queue(queueName, redis);

    await redis.flushdb();

    const job = await queue.add("crash-task", { x: 1 });
    
    // Simulate job being picked up by a worker that then crashes.
    // We manually insert into active hash with 10 minutes ago timestamp.
    const ak = activeKey(queueName);
    const tenMinsAgo = Date.now() - (10 * 60 * 1000);
    
    // In real life, workers add it here via moveToActive.
    await redis.hset(ak, job.id, tenMinsAgo.toString());
    
    // Check it's active
    let activeIds = await queue.getActiveJobs();
    console.log(`Currently Active Job IDs:`, activeIds);
    if (!activeIds.includes(job.id)) throw new Error("Job should be in active hash");

    // 1. Run Stall Detection (Watchdog manual check)
    console.log("\n[Watchdog] Checking for stalled jobs (Timeout: 1m)...");
    const recovered = await queue.checkStalled(60000);
    
    console.log(`Recovered IDs:`, recovered);

    // 2. Verify job is moved back to waiting
    const waitingCount = await queue.getWaitingCount();
    console.log(`Waiting Queue Size: ${waitingCount}`);
    
    activeIds = await queue.getActiveJobs();
    console.log(`Active Queue Size: ${activeIds.length}`);

    if (recovered.includes(job.id) && waitingCount === 1 && activeIds.length === 0) {
        console.log("✅ Stall detection and recovery verified!");
    } else {
        throw new Error("Stall detection failed to recover the job.");
    }

  } catch (err: any) {
    console.error("❌ Phase 23 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 23 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase23();
