import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { jobKey, waitingKey, channelKey } from "../src/keys";
import { generateJobId } from "../src/utils";

async function verifyPhase11() {
  console.log("--- Verifying Phase 11: Implementing enqueue.lua ---");

  try {
    // 1. Load scripts
    await loadScripts(redis);

    // 2. Setup job data
    const queueName = "emails";
    const id = generateJobId();
    const data = JSON.stringify({ to: "test@example.com", subject: "Refactoring" });

    // KEYS for enqueue: jobKey, waitingKey, channelKey
    const jk = jobKey(queueName, id);
    const wk = waitingKey(queueName);
    const ck = channelKey(queueName);

    console.log(`Enqueuing Job ID: ${id}...`);

    // 3. Setup a subscriber to verify the PUBLISH (optional, but robust)
    const sub = redis.duplicate();
    await sub.subscribe(ck);
    let received = false;
    sub.on("message", (channel, message) => {
      if (channel === ck && message === "job_added") {
        received = true;
      }
    });

    // 4. Atomic Enqueue!
    // ioredis needs to know how many keys are passsed
    await (redis as any).enqueue(3, jk, wk, ck, id, data);

    // Give subscriber a tiny moment
    await new Promise(r => setTimeout(r, 100));

    // 5. Assertions
    console.log("Verifying Hash (metadata)...");
    const hData = await redis.hgetall(jk);
    if (hData.id === id && hData.status === "waiting") {
      console.log("✅ Hash data is correct!");
    } else {
      console.error("❌ Hash data is wrong!", hData);
      process.exit(1);
    }

    console.log("Verifying List (waiting queue)...");
    const listId = await redis.lindex(wk, 0);
    if (listId === id) {
      console.log("✅ Job ID is in the waiting list!");
    } else {
      console.error(`❌ Wrong ID in list: expected ${id}, got ${listId}`);
      process.exit(1);
    }

    if (received) {
      console.log("✅ Worker notification received!");
    } else {
      console.error("❌ Worker notification missing!");
      process.exit(1);
    }

    await sub.quit();
  } catch (err: any) {
    console.error("❌ Phase 11 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("--- Phase 11 Verification Passed ---");
    process.exit(0);
  }
}

verifyPhase11();
