-- KEYS[1]: jobKey (queue:name:jobs:id)
-- KEYS[2]: activeKey (queue:name:active)
-- KEYS[3]: waitingKey (queue:name:waiting)
-- KEYS[4]: failedKey (queue:name:failed)
-- ARGV[1]: jobId
-- ARGV[2]: errorMessage
-- ARGV[3]: now
-- ARGV[4]: nextRunAt (Timestamp for retry, aka now + backoff)

-- 1. Remove from active Hash
redis.call("HDEL", KEYS[2], ARGV[1])

-- 2. Fetch retry config
local attempts = tonumber(redis.call("HGET", KEYS[1], "attempts") or 0)
local maxAttempts = tonumber(redis.call("HGET", KEYS[1], "maxAttempts") or 1)

if attempts + 1 < maxAttempts then
    -- RETRY PATH
    redis.call("HSET", KEYS[1], 
        "status", "WAITING", 
        "attempts", attempts + 1,
        "lastError", ARGV[2]
    )
    -- Add back to waiting set with delay
    redis.call("ZADD", KEYS[3], ARGV[4], ARGV[1])
    return 0 -- Indicates retry scheduled
else
    -- FAILURE PATH (Max attempts reached)
    redis.call("HSET", KEYS[1], 
        "status", "FAILED", 
        "failedAt", ARGV[3],
        "error", ARGV[2]
    )
    -- Add to failed history (Sorted Set)
    redis.call("ZADD", KEYS[4], ARGV[3], ARGV[1])
    return 1 -- Indicates final failure
end
