import redis from "../src/redis";
import { loadScripts } from "../src/scripts";
import { jobKey, waitingKey, channelKey, activeKey, completedKey, failedKey } from "../src/keys";
import { generateJobId } from "../src/utils";

async function verifyPhase13() {
  console.log("--- Verifying Phase 13: Implementing complete.lua and fail.lua ---");

  try {
    // 1. Setup
    await loadScripts(redis);
    const queueName = "worker-tasks";

    // --- TEST 1: The Completion Flow ---
    console.log("\n[Scenario 1] Completion Flow...");
    const id1 = generateJobId();
    const jk1 = jobKey(queueName, id1);
    const wk = waitingKey(queueName);
    const ck = channelKey(queueName);
    const ak = activeKey(queueName);
    const comptk = completedKey(queueName);
    const jkPrefix = jk1.replace(id1, ""); 

    await (redis as any).enqueue(3, jk1, wk, ck, id1, "{}");
    await (redis as any).dequeue(3, wk, ak, jkPrefix);
    
    // Perform COMPLETE
    // complete(3, jobKey, activeKey, completedKey, jobId)
    console.log(`Completing Job ID: ${id1}...`);
    await (redis as any).complete(3, jk1, ak, comptk, id1);

    // Assertions
    const status1 = await redis.hget(jk1, "status");
    const activeLen1 = await redis.llen(ak);
    const compLen1 = await redis.llen(comptk);

    if (status1 === "completed" && activeLen1 === 0 && compLen1 === 1) {
      console.log("✅ Completion state transitions verified!");
    } else {
      console.error(`❌ Completion failed! Status=${status1}, Active=${activeLen1}, Comp=${compLen1}`);
      process.exit(1);
    }

    // --- TEST 2: The Failure Flow ---
    console.log("\n[Scenario 2] Failure Flow...");
    const id2 = generateJobId();
    const jk2 = jobKey(queueName, id2);
    const fk = failedKey(queueName);
    const errorMsg = "Something went horribly wrong!";

    await (redis as any).enqueue(3, jk2, wk, ck, id2, "{}");
    await (redis as any).dequeue(3, wk, ak, jkPrefix);
    
    // Perform FAIL
    // fail(3, jobKey, activeKey, failedKey, jobId, errorMsg)
    console.log(`Failing Job ID: ${id2}...`);
    await (redis as any).fail(3, jk2, ak, fk, id2, errorMsg);

    // Assertions
    const hData2 = await redis.hgetall(jk2);
    const activeLen2 = await redis.llen(ak);
    const failIdInList = await redis.lindex(fk, 0);

    if (hData2.status === "failed" && hData2.error === errorMsg && activeLen2 === 0 && failIdInList === id2) {
      console.log("✅ Failure state transitions and error logging verified!");
    } else {
      console.error(`❌ Failure state wrong! Status=${hData2.status}, Active=${activeLen2}, Error=${hData2.error}`);
      process.exit(1);
    }

  } catch (err: any) {
    console.error("❌ Phase 13 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 13 Verification Passed ---");
    process.exit(0);
  }
}

verifyPhase13();
