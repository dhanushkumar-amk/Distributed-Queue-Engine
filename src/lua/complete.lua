-- KEYS[1]: jobKey (queue:name:jobs:id)
-- KEYS[2]: activeKey (queue:name:active)
-- KEYS[3]: completedKey (queue:name:completed)
-- ARGV[1]: jobId

-- 1. Remove from active Hash
redis.call("HDEL", KEYS[2], ARGV[1])

-- 2. Update status to completed
redis.call("HSET", KEYS[1], "status", "completed")

-- 3. Add to history (Optional: we could set an expiry if needed)
-- LPUSH for history list
redis.call("LPUSH", KEYS[3], ARGV[1])

return 1
