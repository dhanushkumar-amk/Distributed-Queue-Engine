import redis from "../src/redis";

async function testRedis() {
  console.log("--- Redis Test Starting ---");
  
  try {
    // 1. Set a key
    console.log("Setting key 'test-key'...");
    await redis.set("test-key", "Hello Redis!");
    
    // 2. Get the key
    const value = await redis.get("test-key");
    console.log(`Retrieved value: ${value}`);
    
    if (value === "Hello Redis!") {
      console.log("✅ Value matches!");
    } else {
      console.error("❌ Value mismatch!");
    }
    
    // 3. Delete the key
    console.log("Deleting 'test-key'...");
    await redis.del("test-key");
    
    // 4. Verify deletion
    const finalValue = await redis.get("test-key");
    if (finalValue === null) {
      console.log("✅ Deletion confirmed.");
    } else {
      console.error("❌ Key still exists!");
    }

  } catch (err) {
    console.error("Test failed with error:", err);
  } finally {
    console.log("--- Redis Test Finished ---");
    process.exit(0);
  }
}

testRedis();
