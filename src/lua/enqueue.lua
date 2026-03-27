-- KEYS[1]: jobKey (queue:name:jobs:id)
-- KEYS[2]: waitingKey (queue:name:waiting)
-- KEYS[3]: channelKey (queue:name:events)
-- ARGV[1]: jobId
-- ARGV[2]: jobJson

-- 1. Save job metadata in a Hash
redis.call("HSET", KEYS[1], "data", ARGV[2], "status", "waiting", "id", ARGV[1])

-- 2. Add to waiting list (LPUSH for FIFO)
redis.call("LPUSH", KEYS[2], ARGV[1])
k
-- 3. Notify workers about new job
redis.call("PUBLISH", KEYS[3], "job_added")

return 1
