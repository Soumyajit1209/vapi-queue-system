// src/queues/QueueManager.ts
import { Queue, QueueEvents, Worker, Job } from 'bullmq';
import { 
  QUEUE_NAMES, 
  QUEUE_OPTIONS, 
  WORKER_OPTIONS,
  JobData,
  redisConnection
} from './config';
import { CallProcessor } from './processors/CallProcessor';
import { EmailProcessor } from './processors/EmailProcessor';
import { SchedulerProcessor } from './processors/SchedulerProcessor';

export class QueueManager {
  private static instance: QueueManager;
  
  // Queues
  public callQueue!: Queue<JobData>;
  public emailQueue!: Queue;
  public schedulerQueue!: Queue;
  
  // Workers
  private callWorker!: Worker<JobData>;
  private emailWorker!: Worker;
  private schedulerWorker!: Worker;
  
  // Queue Events for monitoring
  private callQueueEvents!: QueueEvents;
  private emailQueueEvents!: QueueEvents;
  private schedulerQueueEvents!: QueueEvents;

  private constructor() {
    this.initializeQueues();
    this.initializeWorkers();
    this.initializeQueueEvents();
    this.setupEventListeners();
  }

  public static getInstance(): QueueManager {
    if (!QueueManager.instance) {
      QueueManager.instance = new QueueManager();
    }
    return QueueManager.instance;
  }

  private initializeQueues() {
    this.callQueue = new Queue(QUEUE_NAMES.CALL_QUEUE, QUEUE_OPTIONS);
    this.emailQueue = new Queue(QUEUE_NAMES.EMAIL_QUEUE, QUEUE_OPTIONS);
    this.schedulerQueue = new Queue(QUEUE_NAMES.SCHEDULER_QUEUE, QUEUE_OPTIONS);
  }

  private initializeWorkers() {
    // Call processing worker - single concurrency to avoid VAPI conflicts
    this.callWorker = new Worker(
      QUEUE_NAMES.CALL_QUEUE,
      async (job: Job<JobData>) => {
        const processor = new CallProcessor();
        return await processor.process(job);
      },
      { ...WORKER_OPTIONS, concurrency: 1 }
    );

    // Email worker - can handle multiple concurrent jobs
    this.emailWorker = new Worker(
      QUEUE_NAMES.EMAIL_QUEUE,
      async (job: Job) => {
        const processor = new EmailProcessor();
        return await processor.process(job);
      },
      { ...WORKER_OPTIONS, concurrency: 5 }
    );

    // Scheduler worker - handles recurring tasks
    this.schedulerWorker = new Worker(
      QUEUE_NAMES.SCHEDULER_QUEUE,
      async (job: Job) => {
        const processor = new SchedulerProcessor();
        return await processor.process(job);
      },
      { ...WORKER_OPTIONS, concurrency: 2 }
    );
  }

  private initializeQueueEvents() {
    this.callQueueEvents = new QueueEvents(QUEUE_NAMES.CALL_QUEUE, { connection: redisConnection });
    this.emailQueueEvents = new QueueEvents(QUEUE_NAMES.EMAIL_QUEUE, { connection: redisConnection });
    this.schedulerQueueEvents = new QueueEvents(QUEUE_NAMES.SCHEDULER_QUEUE, { connection: redisConnection });
  }

  private setupEventListeners() {
    // Call queue events
    this.callQueueEvents!.on('completed', ({ jobId }) => {
      console.log(`✅ Call job ${jobId} completed successfully`);
    });

    this.callQueueEvents!.on('failed', ({ jobId, failedReason }) => {
      console.error(`❌ Call job ${jobId} failed:`, failedReason);
    });

    this.callWorker!.on('error', (err) => {
      console.error('❌ Call worker error:', err);
    });

    // Email queue events
    this.emailQueueEvents!.on('completed', ({ jobId }) => {
      console.log(`📧 Email job ${jobId} completed`);
    });

    this.emailQueueEvents!.on('failed', ({ jobId, failedReason }) => {
      console.error(`❌ Email job ${jobId} failed:`, failedReason);
    });

    // Scheduler queue events
    this.schedulerQueueEvents!.on('completed', ({ jobId }) => {
      console.log(`⏰ Scheduler job ${jobId} completed`);
    });

    this.schedulerQueueEvents!.on('failed', ({ jobId, failedReason }) => {
      console.error(`❌ Scheduler job ${jobId} failed:`, failedReason);
    });
  }

  // Add a job to call queue
  public async addCallJob(data: JobData, options?: any) {
    return await this.callQueue!.add('make-call', data, {
      priority: data.priority || 1,
      delay: data.delay || 0,
      ...options
    });
  }

  // Add bulk calls to queue
  public async addBulkCallJobs(jobs: { data: JobData; opts?: any }[]) {
    return await this.callQueue?.addBulk(
      jobs.map(job => ({
        name: 'make-call',
        data: job.data,
        opts: {
          priority: job.data.priority || 1,
          delay: job.data.delay || 0,
          ...job.opts
        }
      }))
    );
  }

  // Add email job
  public async addEmailJob(data: any, options?: any) {
    return await this.emailQueue?.add('send-email', data, options);
  }

  // Add recurring scheduler job
  public async addSchedulerJob(
    name: string, 
    data: any, 
    cronExpression: string,
    options?: any
  ) {
    return await this.schedulerQueue?.add(name, data, {
      repeat: { cron: cronExpression },
      ...options
    });
  }

  // Get queue stats
  public async getQueueStats() {
    const [callStats, emailStats, schedulerStats] = await Promise.all([
      this.callQueue ? this.getQueueCounts(this.callQueue) : Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
      this.emailQueue ? this.getQueueCounts(this.emailQueue) : Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
      this.schedulerQueue ? this.getQueueCounts(this.schedulerQueue) : Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 })
    ]);

    return {
      callQueue: callStats,
      emailQueue: emailStats,
      schedulerQueue: schedulerStats
    };
  }

  private async getQueueCounts(queue: Queue) {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaiting(),
      queue.getActive(),
      queue.getCompleted(),
      queue.getFailed(),
      queue.getDelayed()
    ]);

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      delayed: delayed.length
    };
  }

  // Pause/Resume queues
  public async pauseCallQueue() {
    await this.callQueue!.pause();
    console.log('⏸️ Call queue paused');
  }

  public async resumeCallQueue() {
    await this.callQueue!.resume();
    console.log('▶️ Call queue resumed');
  }

  // Clean up old jobs
  public async cleanupQueues() {
    await Promise.all([
      this.callQueue!.clean(24 * 60 * 60 * 1000, 100), // Clean completed jobs older than 24h
      this.emailQueue!.clean(24 * 60 * 60 * 1000, 100),
      this.schedulerQueue!.clean(24 * 60 * 60 * 1000, 100)
    ]);
    console.log('🧹 Queue cleanup completed');
  }

  // Graceful shutdown
  public async shutdown() {
    console.log('🛑 Shutting down queue manager...');
    
    await Promise.all([
      // Close workers
      this.callWorker!.close(),
      this.emailWorker!.close(),
      this.schedulerWorker!.close(),
      
      // Close queue events
      this.callQueueEvents!.close(),
      this.emailQueueEvents!.close(),
      this.schedulerQueueEvents!.close(),
      
      // Close queues
      this.callQueue!.close(),
      this.emailQueue!.close(),
      this.schedulerQueue!.close()
    ]);

    await redisConnection.disconnect();
    console.log('✅ Queue manager shut down gracefully');
  }
}