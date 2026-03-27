local activeKey = KEYS[1]
local waitingKey = KEYS[2]
local now = tonumber(ARGV[1])
local stallInterval = tonumber(ARGV[2])

local stalled = {}
local activeJobs = redis.call('HGETALL', activeKey)

-- activeJobs is [id1, ts1, id2, ts2, ...]
for i = 1, #activeJobs, 2 do
    local jobId = activeJobs[i]
    local lastHeartbeat = tonumber(activeJobs[i+1])
    
    if (now - lastHeartbeat) > stallInterval then
        -- Move back to waiting (Sorted Set)
        redis.call('ZADD', waitingKey, now, jobId)
        -- Remove from active
        redis.call('HDEL', activeKey, jobId)
        table.insert(stalled, jobId)
    end
end

return stalled
