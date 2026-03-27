import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { jobKey, waitingKey, channelKey, activeKey } from "../src/keys";
import { generateJobId } from "../src/utils";

async function verifyPhase11And12() {
  console.log("--- Verifying Phase 12: Implementing dequeue.lua ---");

  try {
    // 1. Setup
    await loadScripts(redis);
    const queueName = "reports";
    const id = generateJobId();
    const data = JSON.stringify({ type: "pdf", user: "star" });

    const jk = jobKey(queueName, id);
    const wk = waitingKey(queueName);
    const ck = channelKey(queueName);
    const ak = activeKey(queueName);
    // Prefix for dequeue
    const jkPrefix = jk.replace(id, ""); 

    console.log("1. Enqueuing a job...");
    await (redis as any).enqueue(3, jk, wk, ck, id, data);

    console.log("2. Dequeuing the job (Picking it up)...");
    // KEYS for dequeue: waitingKey, activeKey, jobKeyPrefix
    const dequeuedId = await (redis as any).dequeue(3, wk, ak, jkPrefix);

    if (dequeuedId === id) {
      console.log(`✅ Success! Worker picked up Job ID: ${dequeuedId}`);
    } else {
      console.error(`❌ Unexpected ID: ${dequeuedId}, expected ${id}`);
      process.exit(1);
    }

    // 3. Status Check
    console.log("3. Verifying updated status in Hash...");
    const status = await redis.hget(jk, "status");
    if (status === "active") {
      console.log("✅ Hash status correctly updated to 'active'!");
    } else {
      console.error(`❌ Wrong status: ${status}`);
      process.exit(1);
    }

    console.log("4. Verifying move from waiting to active list...");
    const wLen = await redis.llen(wk);
    const aLen = await redis.llen(ak);

    if (wLen === 0 && aLen === 1) {
      console.log("✅ Lists are correctly synchronized!");
    } else {
      console.error(`❌ Wrong list lengths: Waiting=${wLen}, Active=${aLen}`);
      process.exit(1);
    }

  } catch (err: any) {
    console.error("❌ Phase 12 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("--- Phase 12 Verification Passed ---");
    process.exit(0);
  }
}

verifyPhase11And12();
