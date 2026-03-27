import { generateJobId } from "../src/utils";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
  console.log(`✅ ${message}`);
}

async function verifyPhase7() {
  console.log("--- Verifying Phase 7: UUID & Job ID Strategy ---");

  const ITERATIONS = 10000;
  const ids = new Set<string>();

  console.log(`Generating ${ITERATIONS.toLocaleString()} IDs...`);
  const startTime = Date.now();

  for (let i = 0; i < ITERATIONS; i++) {
    const id = generateJobId();
    if (ids.has(id)) {
      throw new Error(`❌ COLLISION DETECTED on ID: ${id}`);
    }
    ids.add(id);
  }

  const duration = Date.now() - startTime;
  console.log(`Successfully generated unique IDs in ${duration}ms.`);
  
  assert(ids.size === ITERATIONS, `${ITERATIONS.toLocaleString()} Unique IDs generated`);
  
  // Verify format: <timestamp>-<uuid>
  const sampleId = generateJobId();
  const parts = sampleId.split("-");
  assert(parts.length > 5, "ID is correctly formatted with multiple segments");
  assert(!isNaN(Number(parts[0])), "First segment is a valid timestamp");

  console.log("--- Phase 7 Verification Passed ---");
}

verifyPhase7().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
