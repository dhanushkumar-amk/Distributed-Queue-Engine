import { jobKey, waitingKey, activeKey, channelKey } from "../src/keys";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
  console.log(`✅ ${message}`);
}

async function verifyPhase6() {
  console.log("--- Verifying Phase 6: Key Naming Convention ---");

  const queue = "emails";
  
  assert(jobKey(queue, "123") === "queue:emails:jobs:123", "jobKey check");
  assert(waitingKey(queue) === "queue:emails:waiting", "waitingKey check");
  assert(activeKey(queue) === "queue:emails:active", "activeKey check");
  assert(channelKey(queue) === "queue:emails:events", "channelKey check");

  console.log("--- Phase 6 Verification Passed ---");
}

verifyPhase6().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
