import express, { Request, Response } from "express";
import User from "./models/User";
import { connectDB } from "./connectDB";
import { QueueManager } from "./queues/QueueManager";
// import { processNextCall } from "./services/callQueueService";
// import { CallQueue } from "./models/callQueue";
///import { callQueue } from "./queue";

const router = express.Router();

// POST /queue-calls - Queue bulk contacts
// @ts-ignore
// POST /queue-calls - Queue bulk contacts with BullMQ
router.post("/queue-calls", async (req: Request, res: Response) => {
  const { clerkId, contacts, assistantId, priority = 1, delay = 0 } = req.body;

  if (!clerkId || !Array.isArray(contacts) || !assistantId) {
    return res.status(400).json({ 
      error: "clerkId, assistantId, and contacts[] are required" 
    });
  }

  try {
    await connectDB();
    const user = await User.findById(clerkId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Validate Twilio configuration
    if (!user.twilioConfig?.sid || !user.twilioConfig?.authToken || !user.twilioConfig?.phoneNumber) {
      return res.status(400).json({ 
        error: "User missing required Twilio configuration" 
      });
    }

    const validContacts = contacts.filter(
      (c: { name: string; number: string }) =>
        typeof c.name === "string" && 
        typeof c.number === "string" &&
        c.name.trim() !== "" &&
        c.number.trim() !== ""
    );

    if (!validContacts.length) {
      return res.status(400).json({ error: "No valid contacts provided" });
    }

    const queueManager = QueueManager.getInstance();

    // Prepare jobs for bulk insertion
    const jobs = validContacts.map((contact, index) => ({
      data: {
        userId: user._id,
        assistantId,
        contact: {
          name: contact.name.trim(),
          number: contact.number.trim()
        },
        priority: priority + (index * 0.01), // Slight priority variation to maintain order
        metadata: {
          queuedAt: new Date().toISOString(),
          source: 'api'
        }
      },
      opts: {
        delay: delay + (index * 1000) // Stagger calls by 1 second each
      }
    }));

    // Add bulk jobs to queue
    const queuedJobs = await queueManager.addBulkCallJobs(jobs);

    console.log(`✅ ${validContacts.length} contacts queued for assistant ${assistantId}`);

    return res.json({
      message: `${validContacts.length} contacts queued successfully`,
      assistantId,
      queuedJobs: queuedJobs.length,
      estimatedStartTime: new Date(Date.now() + delay).toISOString()
    });

  } catch (err) {
    console.error("❌ Queue error:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /start-queue - Start queue processing and return stats
router.post("/start-queue", async (req: Request, res: Response) => {
  const { clerkId } = req.body;

  if (!clerkId) {
    return res.status(400).json({ error: "clerkId is required" });
  }

  try {
    await connectDB();
    const user = await User.findById(clerkId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const queueManager = QueueManager.getInstance();
    
    // Resume queue if it was paused
    await queueManager.resumeCallQueue();
    
    // Get current queue stats
    const stats = await queueManager.getQueueStats();

    return res.json({
      message: "Queue processing started/resumed",
      userId: user._id,
      queueStats: stats.callQueue,
      status: "active"
    });

  } catch (err) {
    console.error("❌ Start queue error:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


// POST /pause-queue - Pause queue processing
router.post("/pause-queue", async (req: Request, res: Response) => {
  const { clerkId } = req.body;

  if (!clerkId) {
    return res.status(400).json({ error: "clerkId is required" });
  }

  try {
    await connectDB();
    const user = await User.findById(clerkId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const queueManager = QueueManager.getInstance();
    await queueManager.pauseCallQueue();

    const stats = await queueManager.getQueueStats();

    return res.json({
      message: "Queue paused successfully",
      userId: user._id,
      queueStats: stats.callQueue,
      status: "paused"
    });

  } catch (err) {
    console.error("❌ Pause queue error:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ error: "Internal Server Error" });
  }
});



// GET /queue-stats - Get detailed queue statistics
router.get("/queue-stats", async (req: Request, res: Response) => {
  const { clerkId } = req.query;

  try {
    const queueManager = QueueManager.getInstance();
    const stats = await queueManager.getQueueStats();

    // If clerkId provided, get user-specific stats
    let userStats = null;
    if (clerkId) {
      await connectDB();
      const user = await User.findById(clerkId);
      if (user) {
        // Get jobs specific to this user (this would require custom filtering)
        userStats = {
          userId: user._id,
          // Add user-specific queue statistics here
        };
      }
    }

    return res.json({
      timestamp: new Date().toISOString(),
      globalStats: stats,
      userStats,
      healthy: stats.callQueue.failed < 10 && stats.callQueue.active < 20
    });

  } catch (err) {
    console.error("❌ Queue stats error:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


// POST /schedule-report - Schedule recurring reports
router.post("/schedule-report", async (req: Request, res: Response) => {
  const { type, schedule, clerkId } = req.body;

  if (!type || !schedule || !clerkId) {
    return res.status(400).json({ 
      error: "type, schedule (cron expression), and clerkId are required" 
    });
  }

  try {
    await connectDB();
    const user = await User.findById(clerkId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const queueManager = QueueManager.getInstance();
    
    const job = await queueManager.addSchedulerJob(
      `${type}-report-${clerkId}`,
      {
        type: `${type}_report`,
        userId: clerkId,
        metadata: {
          scheduledBy: clerkId,
          scheduledAt: new Date().toISOString()
        }
      },
      schedule
    );

    return res.json({
      message: `${type} report scheduled successfully`,
      jobId: job.id,
      schedule,
      nextRun: job.opts.repeat
    });

  } catch (err) {
    console.error("❌ Schedule report error:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE /clear-failed-jobs - Clear failed jobs from queue
router.delete("/clear-failed-jobs", async (req: Request, res: Response) => {
  try {
    const queueManager = QueueManager.getInstance();
    
    // Get failed jobs before clearing
    const failedJobs = await queueManager.callQueue.getFailed();
    const failedCount = failedJobs.length;
    
    // Clear failed jobs
    await queueManager.callQueue.clean(0, 0, 'failed');
    
    return res.json({
      message: `Cleared ${failedCount} failed jobs`,
      clearedCount: failedCount,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error("❌ Clear failed jobs error:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


// GET /health - Enhanced health check with queue status
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const queueManager = QueueManager.getInstance();
    const stats = await queueManager.getQueueStats();
    
    // Simple database connectivity check
    let dbStatus = 'connected';
    try {
      await connectDB();
    } catch (error) {
      dbStatus = 'disconnected';
    }

    const health = {
      status: "ok",
      timestamp: new Date().toISOString(),
      database: dbStatus,
      queues: {
        call: {
          status: stats.callQueue.active > 0 ? 'processing' : 'idle',
          ...stats.callQueue
        },
        email: {
          status: stats.emailQueue.active > 0 ? 'processing' : 'idle',
          ...stats.emailQueue
        }
      },
      uptime: process.uptime()
    };

    res.status(200).json(health);
    
  } catch (error) {
    res.status(503).json({
      status: "error",
      message: "Service unavailable",
      timestamp: new Date().toISOString()
    });
  }
});




export default router;
