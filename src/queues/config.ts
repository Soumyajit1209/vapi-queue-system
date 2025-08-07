import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

// Redis connection configuration
export const redisConnection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  retryStrategy: (times) => {
    return Math.min(times * 100, 2000);
  },
  enableReadyCheck: false,
  maxRetriesPerRequest: null,
});

// Queue names
export const QUEUE_NAMES = {
  CALL_QUEUE: 'call-queue',
  EMAIL_QUEUE: 'email-queue',
  SCHEDULER_QUEUE: 'scheduler-queue'
} as const;

// Default job options
export const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 50,
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 5000,
  },
};

// Queue options
export const QUEUE_OPTIONS = {
  connection: redisConnection,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
};

// Worker options
export const WORKER_OPTIONS = {
  connection: redisConnection,
  concurrency: 1, // Process one call at a time to avoid VAPI conflicts
};

export type JobData = {
  userId: string;
  assistantId: string;
  contact: {
    name: string;
    number: string;
  };
  priority?: number;
  delay?: number;
  metadata?: Record<string, any>;
};