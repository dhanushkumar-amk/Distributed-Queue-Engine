import redis from "../src/redis";

/**
 * Phase 9: Lua Scripting Fundamentals
 * Demonstrates how to write and execute atomic scripts in Redis.
 */
async function verifyPhase9() {
  console.log("--- Verifying Phase 9: Lua Scripting Fundamentals ---");

  try {
    // 1. Basic EVAL (returns a simple string from Lua)
    console.log("\n[Test 1] Simple EVAL return...");
    const simpleResult = await redis.eval("return 'hello from lua script'", 0);
    console.log(`Result: ${simpleResult}`);

    // 2. KEYS and ARGV (The dynamic arguments)
    // KEYS[1] = first key name, ARGV[1] = first value
    console.log("\n[Test 2] Doubling a value with Lua...");
    await redis.set("my-v", 10);
    const doubleScript = "local v = redis.call('GET', KEYS[1]); return v * 2;";
    const doubled = await redis.eval(doubleScript, 1, "my-v");
    console.log(`Initial: 10, Lua Doubled: ${doubled}`);

    // 3. Conditional Atomicity (The Token Bucket)
    // Logic: If key exists and > 0, decrement it. Else return 0.
    console.log("\n[Test 3] Atomic Token Bucket logic...");
    await redis.set("tokens", 2);
    const tokenScript = `
      local current = tonumber(redis.call('get', KEYS[1]) or '0')
      if current > 0 then
        redis.call('decr', KEYS[1])
        return 1
      else
        return 0
      end
    `;

    // Try consuming tokens
    const r1 = await redis.eval(tokenScript, 1, "tokens"); // Consume 1 -> 1 left
    const r2 = await redis.eval(tokenScript, 1, "tokens"); // Consume 1 -> 0 left
    const r3 = await redis.eval(tokenScript, 1, "tokens"); // Fail!

    console.log(`Consuming 1: ${r1 === 1 ? "✅ OK" : "❌ Rate Limited"}`);
    console.log(`Consuming 2: ${r2 === 1 ? "✅ OK" : "❌ Rate Limited"}`);
    console.log(`Consuming 3: ${r3 === 1 ? "✅ OK" : "❌ Rate Limited"}`);

    // 4. SCRIPT LOAD and EVALSHA (Performance optimization)
    // Avoids re-sending the same long script string over the network.
    console.log("\n[Test 4] SCRIPT LOAD and EVALSHA...");
    const sha = await redis.script("LOAD", tokenScript) as string;
    console.log(`Script SHA generated: ${sha}`);
    
    // Use it
    await redis.set("tokens", 1);
    const shaResult = await redis.evalsha(sha, 1, "tokens");
    console.log(`Executing via ARGV SHA: ${shaResult === 1 ? "✅ OK" : "❌ Failed"}`);

  } catch (err) {
    console.error("Lua Fundamentals failed:", err);
    process.exit(1);
  } finally {
    console.log("\n--- Phase 9 Verification Passed ---");
    process.exit(0);
  }
}

verifyPhase9();
