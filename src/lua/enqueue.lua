-- KEYS[1]: jobKey
-- KEYS[2]: waitingKey
-- KEYS[3]: delayedKey
-- KEYS[4]: channelKey
-- ARGV[1]: jobId
-- ARGV[2]: jobJson
-- ARGV[3]: runAt (timestamp)
-- ARGV[4]: maxAttempts
-- ARGV[5]: priorityScore
-- ARGV[6]: now

-- 1. Save metadata
redis.call("HSET", KEYS[1], 
    "data", ARGV[2], 
    "status", "WAITING", 
    "id", ARGV[1], 
    "runAt", ARGV[3],
    "attempts", "0",
    "maxAttempts", ARGV[4],
    "priority", ARGV[5]
)

-- 2. Route to appropriate set
if tonumber(ARGV[3]) > tonumber(ARGV[6]) then
    -- Delayed
    redis.call("ZADD", KEYS[3], ARGV[3], ARGV[1])
else
    -- Ready (Priority score)
    redis.call("ZADD", KEYS[2], ARGV[5], ARGV[1])
end

-- 3. Notify
redis.call("PUBLISH", KEYS[4], "job_added")

return 1
