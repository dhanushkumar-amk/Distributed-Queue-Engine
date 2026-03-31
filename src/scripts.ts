import fs from 'fs';
import path from 'path';
import { Redis } from 'ioredis';

// Type definitions for our dynamic Redis methods
// This allows TS to know about the commands we inject at runtime
declare module 'ioredis' {
  interface Redis {
    hello(numKeys: number, name: string): Promise<string>;
    // Our core queue commands
    enqueue(numKeys: number, jobKey: string, waitingKey: string, delayedKey: string, channelKey: string, idempotencyKey: string, jobId: string, jobJson: string, runAt: number, maxAttempts: number, priorityScore: number, now: number): Promise<string>;
    moveToActive(numKeys: number, delayedKey: string, waitingKey: string, activeKey: string, limiterKey: string, now: number, jobKeyPrefix: string, limitMax: number, limitDuration: number): Promise<string | null>;
    complete(numKeys: number, jobKey: string, activeKey: string, completedKey: string, throughputKey: string, jobId: string, now: number): Promise<number>;
    fail(numKeys: number, jobKey: string, activeKey: string, waitingKey: string, failedKey: string, jobId: string, errorMsg: string, now: number, nextRunAt: number): Promise<number>;
    heartbeat(numKeys: number, activeKey: string, jobId: string, now: number): Promise<number>;
    cleanStalled(numKeys: number, activeKey: string, waitingKey: string, now: number, stallInterval: number): Promise<string[]>;
    updateProgress(numKeys: number, jobKey: string, progress: string): Promise<number>;
    cancel(numKeys: number, jobKey: string, activeKey: string, waitingKey: string, cancelledKey: string, jobId: string, now: number): Promise<number>;
    cleanup(numKeys: number, setKey: string, jobPrefix: string, maxAge: number, maxCount: number, now: number): Promise<number>;
    // Add other commands here as we create them
  }
}

/**
 * Loads all .lua scripts from the src/lua directory into the Redis instance.
 * Using defineCommand allows us to call these scripts as methods on the redis object.
 */
export async function loadScripts(redis: Redis): Promise<void> {
  const luaDir = path.join(__dirname, 'lua');
  
  if (!fs.existsSync(luaDir)) {
    console.warn("⚠️ No Lua directory found at:", luaDir);
    return;
  }

  const files = fs.readdirSync(luaDir).filter(file => file.endsWith('.lua'));

  for (const file of files) {
    const scriptName = path.parse(file).name; // e.g., 'hello' from 'hello.lua'
    const scriptContent = fs.readFileSync(path.join(luaDir, file), 'utf8');

    // ioredis specific: register the command
    // Note: In a real queue, we'd need to know the number of keys.
    // We'll adopt a convention: the first line comment defines the key count, 
    // or we'll default to 0 for these basic tests.
    redis.defineCommand(scriptName, {
      lua: scriptContent
    });

    console.log(`📡 Loaded Lua command: redis.${scriptName}()`);
  }
}
