import Redis from "ioredis";

const redis = new Redis({
  host: "localhost",
  port: 6379,
  retryStrategy(times) {
    if (times > 10) {
      console.error("Redis: Max retries reached. Shutting down.");
      return null; // stop retrying
    }
    console.log(`Redis: Reconnecting... (Attempt ${times})`);
    return 500; // wait 500ms
  },
});

redis.on("connect", () => {
  console.log("Redis: Connected successfully.");
});

redis.on("error", (err) => {
  console.error("Redis: Connection Error", err);
});

redis.on("reconnecting", () => {
  console.log("Redis: Reconnecting...");
});

export default redis;
