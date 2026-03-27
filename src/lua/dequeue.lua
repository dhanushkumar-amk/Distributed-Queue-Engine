-- KEYS[1]: waitingKey (queue:name:waiting)
-- KEYS[2]: activeKey (queue:name:active)
-- KEYS[3]: jobKeyPrefix (queue:name:jobs:)

-- 1. Get the next job from the waiting list (atomically)
-- RPOP picks from the end for FIFO
local jobId = redis.call("RPOP", KEYS[1])

if jobId then
  -- 2. Construct the specific job key
  local jobKey = KEYS[3] .. jobId
  
  -- 3. Update status in metadata Hash
  redis.call("HSET", jobKey, "status", "active")
  
  -- 4. Move to active list for tracking or monitoring
  -- (This helps us track which workers are doing what)
  redis.call("LPUSH", KEYS[2], jobId)
  
  return jobId
else
  -- No jobs to process
  return nil
end
