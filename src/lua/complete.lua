-- KEYS[1]: jobKey (queue:name:jobs:id)
-- KEYS[2]: activeKey (queue:name:active)
-- KEYS[3]: completedKey (queue:name:completed)
-- ARGV[1]: jobId
-- ARGV[2]: now (Current timestamp in ms)

-- 1. Remove from active Hash
redis.call("HDEL", KEYS[2], ARGV[1])

-- 2. Update job metadata
redis.call("HSET", KEYS[1], 
    "status", "COMPLETED", 
    "completedAt", ARGV[2]
)

-- 3. Add to completed history (Sorted Set for time-based tracking)
redis.call("ZADD", KEYS[3], ARGV[2], ARGV[1])

-- 4. TTL / Retention (Auto-delete jobs older than 24h from the list)
-- 86,400,000 ms = 24 hours
local expiration = tonumber(ARGV[2]) - 86400000
redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", expiration)

return 1
