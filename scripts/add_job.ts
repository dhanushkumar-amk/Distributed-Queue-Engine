import { Queue } from './src/Queue';
import Redis from 'ioredis';

const redis = new Redis('redis://localhost:6379');
const emailsQueue = new Queue('emails', redis);

async function main() {
  console.log('Adding a test job to emails queue...');
  const jobId = await emailsQueue.add('welcome-email', {
    to: 'test@example.com',
    subject: 'Welcome!'
  });
  console.log(`Job added with ID: ${jobId}`);
  redis.quit();
}

main().catch(console.error);
