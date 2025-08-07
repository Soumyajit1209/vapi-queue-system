// index.ts
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { connectDB } from "./src/connectDB";
import { config, validateEnv } from "./src/config";
import routes from "./src/routes";
import webhookRoutes from "./src/webhooks";
import { QueueManager } from "./src/queues/QueueManager";

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
app.use("/api", routes);
app.use("/webhook", webhookRoutes);

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Global error handler:', err);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({ error: 'Route not found' });
});

async function startServer() {
  try {
    // Validate environment variables
    const missingVars = validateEnv();
    if (missingVars.length > 0) {
      console.error('❌ Missing required environment variables:', missingVars.join(', '));
      process.exit(1);
    }

    // Connect to database
    await connectDB();
    console.log('✅ Database connected successfully');

    // Initialize queue manager
    const queueManager = QueueManager.getInstance();
    console.log('✅ Queue manager initialized');

    // Schedule recurring jobs
    await scheduleRecurringJobs(queueManager);

    // Start server
    const server = app.listen(config.server.port, () => {
      console.log(`🚀 Server running on port ${config.server.port}`);
      console.log(`📊 Queue dashboard available at http://localhost:${config.server.port}/admin/queues`);
    });

    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
      
      // Stop accepting new requests
      server.close(() => {
        console.log('✅ HTTP server closed');
      });

      try {
        // Shutdown queue manager
        await queueManager.shutdown();
        
        // Close database connection
        const mongoose = await import('mongoose');
        await mongoose.disconnect();
        console.log('✅ Database connection closed');

        process.exit(0);
      } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
      }
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('❌ Uncaught Exception:', error);
      gracefulShutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
      gracefulShutdown('unhandledRejection');
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

async function scheduleRecurringJobs(queueManager: QueueManager) {
  try {
    // Schedule daily report at 6:00 AM every day
    await queueManager.addSchedulerJob(
      'daily-report',
      { type: 'daily_report' },
      '0 6 * * *', // Every day at 6:00 AM
      { priority: 1 }
    );

    // Schedule weekly report every Sunday at 8:00 AM
    await queueManager.addSchedulerJob(
      'weekly-report',
      { type: 'weekly_report' },
      '0 8 * * 0', // Every Sunday at 8:00 AM
      { priority: 2 }
    );

    // Schedule monthly report on the 1st of every month at 9:00 AM
    await queueManager.addSchedulerJob(
      'monthly-report',
      { type: 'monthly_report' },
      '0 9 1 * *', // 1st day of every month at 9:00 AM
      { priority: 3 }
    );

    // Schedule cleanup job daily at 2:00 AM
    await queueManager.addSchedulerJob(
      'daily-cleanup',
      { type: 'cleanup' },
      '0 2 * * *', // Every day at 2:00 AM
      { priority: 5 }
    );

    // Schedule health check every 30 minutes
    await queueManager.addSchedulerJob(
      'health-check',
      { type: 'health_check' },
      '*/30 * * * *', // Every 30 minutes
      { priority: 10 }
    );

    console.log('✅ Recurring jobs scheduled successfully');

  } catch (error) {
    console.error('❌ Failed to schedule recurring jobs:', error);
    // Don't exit the process, just log the error
  }
}

// Start the server
startServer().catch((error) => {
  console.error('❌ Server startup failed:', error);
  process.exit(1);
});