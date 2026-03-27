-- KEYS[1]: waitingKey (queue:name:waiting)
-- KEYS[2]: activeKey (queue:name:active)
-- KEYS[3]: jobKeyPrefix (queue:name:jobs:)
-- ARGV[1]: now (Current timestamp in ms)

-- 1. Scan for one ready job (score <= now)
local result = redis.call("ZRANGEBYSCORE", KEYS[1], 0, ARGV[1], "LIMIT", 0, 1)
local jobId = result[1]

if jobId then
  -- 2. Construct the specific job key
  local jobKey = KEYS[3] .. jobId
  
  -- 3. Atomic state transition
  -- Update job metadata with timestamps (Phase 15 requirement)
  redis.call("HSET", jobKey, 
    "status", "ACTIVE", 
    "startedAt", ARGV[1], 
    "heartbeatAt", ARGV[1]
  )
  
  -- 4. Move to active HASH (Efficient for heartbeats across all jobs)
  -- Maps jobId -> heartbeatAt
  redis.call("HSET", KEYS[2], jobId, ARGV[1])

  -- 5. Remove from waiting Sorted Set
  redis.call("ZREM", KEYS[1], jobId)
  
  return jobId
else
  -- No jobs ready to process
  return nil
end
