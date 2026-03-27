import redis from "../src/redis";
import { loadScripts } from "../src/scripts";

async function verifyPhase10() {
  console.log("--- Verifying Phase 10: Lua Script Loading Strategy ---");

  try {
    // 1. Load the scripts into our redis instance
    console.log("Loading Lua scripts into Redis...");
    await loadScripts(redis);

    // 2. Call our custom injected method directly
    // Note: ioredis adds the method dynamically to the 'redis' object.
    // Our 'hello.lua' takes 0 KEYS and 1 ARGV (the name).
    console.log("Testing redis.hello(0, 'Phase 10')...");
    
    // cast to 'any' for the verification test as the types might not sync 
    // immediately in this environment
    const result = await (redis as any).hello(0, "Phase 10-Worker");

    if (result === "Hello from Phase 10-Worker") {
      console.log(`✅ Success! Redis returned: "${result}"`);
    } else {
      console.error(`❌ Unexpected result: "${result}"`);
      process.exit(1);
    }

  } catch (err: any) {
    console.error("❌ Phase 10 Failed Error:", err.message);
    process.exit(1);
  } finally {
    console.log("--- Phase 10 Verification Passed ---");
    process.exit(0);
  }
}

verifyPhase10();
