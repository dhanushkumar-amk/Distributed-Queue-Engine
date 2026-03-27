local jobKey = KEYS[1]
local activeKey = KEYS[2]
local waitingKey = KEYS[3]
local cancelledKey = KEYS[4]
local jobId = ARGV[1]
local now = ARGV[2]

-- Try remove from waiting / delayed
local removed = redis.call('ZREM', waitingKey, jobId)

-- Try remove from active
local removedFromActive = redis.call('HDEL', activeKey, jobId)

-- Finalize status
redis.call('HSET', jobKey, 'status', 'CANCELLED', 'cancelledAt', now)
redis.call('ZADD', cancelledKey, now, jobId)

return 1
