-- KEYS[1]: jobKey (queue:name:jobs:id)
-- KEYS[2]: activeKey (queue:name:active)
-- KEYS[3]: failedKey (queue:name:failed)
-- ARGV[1]: jobId
-- ARGV[2]: errorMessage

-- 1. Remove from active Hash
redis.call("HDEL", KEYS[2], ARGV[1])

-- 2. Update status to FAILED and store the error
redis.call("HSET", KEYS[1], "status", "FAILED", "error", ARGV[2])

-- 3. Add to failed list for dead-letter queuing or retry logic
redis.call("LPUSH", KEYS[3], ARGV[1])

return 1
