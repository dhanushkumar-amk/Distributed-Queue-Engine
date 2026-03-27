// We'll simulate a missing config by clearing the env variable manually
process.env.REDIS_URL = "";

async function verifyPhase8() {
  console.log("--- Verifying Phase 8: Configuration & Validation ---");

  try {
    console.log("Testing validation with MISSING REDIS_URL...");
    // Clear the require cache so we can reload the config module
    delete require.cache[require.resolve("../src/config")];
    
    // This should throw
    require("../src/config");
    console.error("❌ FAILED: Config did not throw on missing REDIS_URL");
    process.exit(1);
  } catch (err: any) {
    if (err.message.includes("Missing required environment variable: REDIS_URL")) {
      console.log("✅ Caught expected error! Startup validation is working.");
    } else {
      console.error("❌ Caught wrong error:", err.message);
      process.exit(1);
    }
  }

  // Restore for standard verification
  process.env.REDIS_URL = "redis://localhost:6379";
  delete require.cache[require.resolve("../src/config")];
  const config = require("../src/config");
  
  if (config.REDIS_URL === "redis://localhost:6379" && config.HEARTBEAT_INTERVAL_MS === 5000) {
    console.log("✅ Config successfully loaded defaults from .env");
  } else {
    console.error("❌ Config failed to load defaults correctly");
    process.exit(1);
  }

  console.log("--- Phase 8 Verification Passed ---");
}

verifyPhase8().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
