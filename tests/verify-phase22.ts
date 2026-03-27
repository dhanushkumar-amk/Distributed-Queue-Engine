import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { Queue } from "../src/Queue";
import { Worker } from "../src/Worker";
import { activeKey } from "../src/keys";

async function verifyPhase22() {
  console.log("--- Verifying Phase 22: Heartbeats & Active Monitoring ---");

  try {
    await loadScripts(redis);
    const queueName = "heartbeat-test-queue";
    const queue = new Queue(queueName, redis);

    await redis.flushdb();

    const job = await queue.add("long-job", { duration: 5000 });
    
    // We'll override the heartbeat interval for testing (too fast is bad in prod, but fine for test)
    const worker = new Worker(queueName, async () => {
        await new Promise(r => setTimeout(r, 4000)); // 4 second job
    }, redis);

    // Patch worker for test
    (worker as any).heartbeatInterval = 1000; 

    await worker.start();

    // Check heartbeat in active hash
    const ak = activeKey(queueName);
    
    // Initial check
    await new Promise(r => setTimeout(r, 500));
    const startHeartbeat = await redis.hget(ak, job.id);
    console.log(`Initial Heartbeat: ${startHeartbeat}`);

    // Wait and check again
    await new Promise(r => setTimeout(r, 2000));
    const laterHeartbeat = await redis.hget(ak, job.id);
    console.log(`Later Heartbeat:   ${laterHeartbeat}`);

    if (laterHeartbeat && Number(laterHeartbeat) > Number(startHeartbeat)) {
        console.log("✅ Heartbeat updated successfully in Redis!");
    } else {
        throw new Error(`Heartbeat failed to update! Start: ${startHeartbeat}, Later: ${laterHeartbeat}`);
    }

    await worker.stop();

  } catch (err: any) {
    console.error("❌ Phase 22 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 22 Verification Successfully Passed ---");
    process.exit(0);
  }
}

verifyPhase22();
