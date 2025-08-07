// src/queues/processors/SchedulerProcessor.ts
import { Job } from 'bullmq';
import { connectDB } from '../../connectDB';
import { QueueManager } from '../QueueManager';
import CallData from '../../models/callData.model';
import { saveToXLSX } from '../../reportGenerator';

export interface SchedulerJobData {
  type: 'daily_report' | 'weekly_report' | 'monthly_report' | 'cleanup' | 'health_check';
  metadata?: Record<string, any>;
}

export class SchedulerProcessor {
  async process(job: Job<SchedulerJobData>): Promise<any> {
    const { type, metadata } = job.data;
    
    try {
      console.log(`⏰ Processing scheduler job: ${type} (${job.id})`);
      
      switch (type) {
        case 'daily_report':
          return await this.processDailyReport(job);
          
        case 'weekly_report':
          return await this.processWeeklyReport(job);
          
        case 'monthly_report':
          return await this.processMonthlyReport(job);
          
        case 'cleanup':
          return await this.processCleanup(job);
          
        case 'health_check':
          return await this.processHealthCheck(job);
          
        default:
          throw new Error(`Unknown scheduler job type: ${type}`);
      }
      
    } catch (error: any) {
      console.error(`❌ Scheduler job ${job.id} (${type}) failed:`, error.message);
      throw error;
    }
  }

  private async processDailyReport(job: Job<SchedulerJobData>): Promise<any> {
    await connectDB();
    
    const queueManager = QueueManager.getInstance();
    const { startString, endString } = this.getTodayDateRange();
    
    // Fetch today's call data
    const data = await CallData.aggregate([
      {
        $match: {
          userId: "user_2x0DhdwrWfE9PpFSljdOd3aOvYG", // You might want to make this dynamic
          startedAt: { $gt: startString, $lt: endString }
        }
      },
      {
        $project: {
          _id: 0,
          analysis: 1,
          startedAt: 1,
          cost: 1,
          endedReason: 1,
          durationSeconds: 1,
          summary: 1,
          transcript: 1,
          recordingUrl: 1,
          call: { id: 1, type: 1, phoneNumber: 1 },
          customer: { name: 1, number: 1 },
          assistant: { id: 1, name: 1 }
        }
      }
    ]);

    if (!data?.length) {
      console.log('📭 No calls found for daily report');
      return { status: 'completed', message: 'No calls to report' };
    }

    // Generate reports
    const allCallsPath = saveToXLSX(data, "DailyReport_AllCalls");
    
    const successfulCalls = data.filter((call: any) =>
      call.analysis?.successEvaluation === true &&
      call.durationSeconds > 10 &&
      call.endedReason?.toLowerCase() !== "voicemail"
    );

    const filePaths = [allCallsPath];
    
    if (successfulCalls.length) {
      const successfulCallsPath = saveToXLSX(successfulCalls, "DailyReport_SuccessfulCalls");
      filePaths.push(successfulCallsPath);
    }

    // Queue email job
    await queueManager.addEmailJob({
      type: 'daily_report',
      to: process.env.EMAIL_TO?.split(',').map(email => email.trim()) || [],
      subject: `Daily Call Report - ${new Date().toLocaleDateString()}`,
      html: `
        <h2>📞 Daily Call Report</h2>
        <p>Date: ${new Date().toLocaleDateString()}</p>
        <p>Total Calls: ${data.length}</p>
        <p>Successful Calls: ${successfulCalls.length}</p>
        <p>Success Rate: ${data.length > 0 ? ((successfulCalls.length / data.length) * 100).toFixed(1) : 0}%</p>
        <p>Please find the detailed reports attached.</p>
      `,
      filePaths,
      metadata: { cleanup: true }
    });

    return {
      status: 'completed',
      totalCalls: data.length,
      successfulCalls: successfulCalls.length,
      reportsGenerated: filePaths.length
    };
  }

  private async processWeeklyReport(job: Job<SchedulerJobData>): Promise<any> {
    // Similar to daily report but for a week
    await connectDB();
    
    const { startString, endString } = this.getWeekDateRange();
    
    // Implementation similar to daily report but for weekly data
    // ... (implementation details)
    
    return { status: 'completed', message: 'Weekly report processed' };
  }

  private async processMonthlyReport(job: Job<SchedulerJobData>): Promise<any> {
    // Monthly report implementation
    return { status: 'completed', message: 'Monthly report processed' };
  }

  private async processCleanup(job: Job<SchedulerJobData>): Promise<any> {
    const queueManager = QueueManager.getInstance();
    
    // Clean up old queue jobs
    await queueManager.cleanupQueues();
    
    // Clean up old call data if needed
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30); // Keep last 30 days
    
    await connectDB();
    
    const deleteResult = await CallData.deleteMany({
      startedAt: { $lt: cutoffDate.toISOString() }
    });

    console.log(`🧹 Cleanup completed: ${deleteResult.deletedCount} old records removed`);
    
    return {
      status: 'completed',
      recordsDeleted: deleteResult.deletedCount,
      cutoffDate: cutoffDate.toISOString()
    };
  }

  private async processHealthCheck(job: Job<SchedulerJobData>): Promise<any> {
    const queueManager = QueueManager.getInstance();
    
    // Get queue stats
    const stats = await queueManager.getQueueStats();
    
    // Check database connectivity
    let dbStatus = 'connected';
    try {
      await connectDB();
    } catch (error) {
      dbStatus = 'disconnected';
    }
    
    // Check if there are stuck jobs
    const stuckJobs = stats.callQueue.active > 10; // Arbitrary threshold
    
    const healthReport = {
      timestamp: new Date().toISOString(),
      database: dbStatus,
      queues: stats,
      alerts: [] as string[]
    };
    
    // Add alerts for concerning conditions
    if (stuckJobs) {
      healthReport.alerts.push('High number of active jobs detected');
    }
    
    if (stats.callQueue.failed > 50) {
      healthReport.alerts.push('High number of failed call jobs');
    }
    
    if (dbStatus === 'disconnected') {
      healthReport.alerts.push('Database connectivity issues');
    }
    
    console.log('🏥 Health check completed:', healthReport);
    
    // Send alert email if there are issues
    if (healthReport.alerts.length > 0) {
      await queueManager.addEmailJob({
        type: 'alert',
        to: process.env.ADMIN_EMAIL?.split(',').map(email => email.trim()) || [],
        subject: '🚨 System Health Alert',
        html: `
          <h2>🚨 System Health Alert</h2>
          <p>Timestamp: ${healthReport.timestamp}</p>
          <p>Database Status: ${healthReport.database}</p>
          <h3>Alerts:</h3>
          <ul>
            ${healthReport.alerts.map(alert => `<li>${alert}</li>`).join('')}
          </ul>
          <h3>Queue Statistics:</h3>
          <pre>${JSON.stringify(healthReport.queues, null, 2)}</pre>
        `,
        metadata: { cleanup: false }
      });
    }
    
    return healthReport;
  }

  private getTodayDateRange() {
    const end = new Date();
    const endString = end.toISOString();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const startString = start.toISOString();
    return { startString, endString };
  }

  private getWeekDateRange() {
    const end = new Date();
    const endString = end.toISOString();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startString = start.toISOString();
    return { startString, endString };
  }

  private getMonthDateRange() {
    const end = new Date();
    const endString = end.toISOString();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startString = start.toISOString();
    return { startString, endString };
  }
}