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
    const userId = job.data.metadata?.userId;
    
    // Fetch today's call data
    const data = await CallData.aggregate([
      {
        $match: {
          userId,
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
      console.log(`📭 No calls found for daily report for user ${userId}`);
      return { status: 'completed', message: 'No calls to report' };
    }

    // Generate reports
    const allCallsPath = saveToXLSX(data, `DailyReport_AllCalls_${userId}`);
    
    const successfulCalls = data.filter((call: any) =>
      call.analysis?.successEvaluation === true &&
      call.durationSeconds > 10 &&
      call.endedReason?.toLowerCase() !== "voicemail"
    );

    const filePaths = [allCallsPath];
    
    if (successfulCalls.length) {
      const successfulCallsPath = saveToXLSX(successfulCalls, `DailyReport_SuccessfulCalls_${userId}`);
      filePaths.push(successfulCallsPath);
    }

    // Queue email job
    await queueManager.addEmailJob({
      type: 'daily_report',
      to: process.env.EMAIL_TO?.split(',').map(email => email.trim()) || [],
      subject: `Daily Call Report - ${new Date().toLocaleDateString()} (User: ${userId})`,
      html: `
        <h2>📞 Daily Call Report</h2>
        <p>User: ${userId}</p>
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
      userId,
      totalCalls: data.length,
      successfulCalls: successfulCalls.length,
      reportsGenerated: filePaths.length
    };
  }

  private async processWeeklyReport(job: Job<SchedulerJobData>): Promise<any> {
    await connectDB();
    
    const queueManager = QueueManager.getInstance();
    const { startString, endString } = this.getWeekDateRange();
    const userId = job.data.metadata?.userId;
    
    // Fetch weekly call data with additional aggregations
    const data = await CallData.aggregate([
      {
        $match: {
          userId,
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
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$startedAt" } },
            assistantId: "$assistant.id"
          },
          totalCalls: { $sum: 1 },
          totalDuration: { $sum: "$durationSeconds" },
          successfulCalls: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$analysis.successEvaluation", true] },
                    { $gt: ["$durationSeconds", 10] },
                    { $ne: [{ $toLower: "$endedReason" }, "voicemail"] }
                  ]
                },
                1,
                0
              ]
            }
          },
          totalCost: { $sum: "$cost" },
          calls: { $push: "$$ROOT" }
        }
      },
      {
        $sort: { "_id.date": 1 }
      }
    ]);

    if (!data?.length) {
      console.log(`📭 No calls found for weekly report for user ${userId}`);
      return { status: 'completed', message: 'No calls to report' };
    }

    // Generate reports
    const allCalls = data.flatMap(day => day.calls);
    const allCallsPath = saveToXLSX(allCalls, `WeeklyReport_AllCalls_${userId}`);
    
    const successfulCalls = allCalls.filter((call: any) =>
      call.analysis?.successEvaluation === true &&
      call.durationSeconds > 10 &&
      call.endedReason?.toLowerCase() !== "voicemail"
    );

    const filePaths = [allCallsPath];
    
    if (successfulCalls.length) {
      const successfulCallsPath = saveToXLSX(successfulCalls, `WeeklyReport_SuccessfulCalls_${userId}`);
      filePaths.push(successfulCallsPath);
    }

    // Generate summary statistics
    const totalCalls = data.reduce((sum, day) => sum + day.totalCalls, 0);
    const totalSuccessfulCalls = data.reduce((sum, day) => sum + day.successfulCalls, 0);
    const totalDuration = data.reduce((sum, day) => sum + day.totalDuration, 0);
    const totalCost = data.reduce((sum, day) => sum + day.totalCost, 0);

    // Queue email job
    await queueManager.addEmailJob({
      type: 'weekly_report',
      to: process.env.EMAIL_TO?.split(',').map(email => email.trim()) || [],
      subject: `Weekly Call Report - ${new Date(startString).toLocaleDateString()} to ${new Date(endString).toLocaleDateString()} (User: ${userId})`,
      html: `
        <h2>📞 Weekly Call Report</h2>
        <p>User: ${userId}</p>
        <p>Period: ${new Date(startString).toLocaleDateString()} to ${new Date(endString).toLocaleDateString()}</p>
        <p>Total Calls: ${totalCalls}</p>
        <p>Successful Calls: ${totalSuccessfulCalls}</p>
        <p>Success Rate: ${totalCalls > 0 ? ((totalSuccessfulCalls / totalCalls) * 100).toFixed(1) : 0}%</p>
        <p>Average Call Duration: ${(totalDuration / totalCalls).toFixed(1)} seconds</p>
        <p>Total Cost: $${totalCost.toFixed(2)}</p>
        <h3>Daily Breakdown:</h3>
        <ul>
          ${data.map(day => `
            <li>
              ${day._id.date}: ${day.totalCalls} calls (${day.successfulCalls} successful)
              - Avg Duration: ${(day.totalDuration / day.totalCalls).toFixed(1)}s
              - Cost: $${day.totalCost.toFixed(2)}
            </li>
          `).join('')}
        </ul>
        <p>Please find the detailed reports attached.</p>
      `,
      filePaths,
      metadata: { cleanup: true }
    });

    return {
      status: 'completed',
      userId,
      totalCalls,
      successfulCalls: totalSuccessfulCalls,
      averageDuration: totalDuration / totalCalls,
      totalCost,
      reportsGenerated: filePaths.length
    };
  }

  private async processMonthlyReport(job: Job<SchedulerJobData>): Promise<any> {
    await connectDB();
    
    const queueManager = QueueManager.getInstance();
    const { startString, endString } = this.getMonthDateRange();
    const userId = job.data.metadata?.userId;
    
    // Fetch monthly call data with comprehensive aggregations
    const data = await CallData.aggregate([
      {
        $match: {
          userId,
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
      },
      {
        $group: {
          _id: {
            week: { $week: "$startedAt" },
            assistantId: "$assistant.id"
          },
          totalCalls: { $sum: 1 },
          totalDuration: { $sum: "$durationSeconds" },
          successfulCalls: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$analysis.successEvaluation", true] },
                    { $gt: ["$durationSeconds", 10] },
                    { $ne: [{ $toLower: "$endedReason" }, "voicemail"] }
                  ]
                },
                1,
                0
              ]
            }
          },
          totalCost: { $sum: "$cost" },
          calls: { $push: "$$ROOT" }
        }
      },
      {
        $sort: { "_id.week": 1 }
      }
    ]);

    if (!data?.length) {
      console.log(`📭 No calls found for monthly report for user ${userId}`);
      return { status: 'completed', message: 'No calls to report' };
    }

    // Generate reports
    const allCalls = data.flatMap(week => week.calls);
    const allCallsPath = saveToXLSX(allCalls, `MonthlyReport_AllCalls_${userId}`);
    
    const successfulCalls = allCalls.filter((call: any) =>
      call.analysis?.successEvaluation === true &&
      call.durationSeconds > 10 &&
      call.endedReason?.toLowerCase() !== "voicemail"
    );

    const filePaths = [allCallsPath];
    
    if (successfulCalls.length) {
      const successfulCallsPath = saveToXLSX(successfulCalls, `MonthlyReport_SuccessfulCalls_${userId}`);
      filePaths.push(successfulCallsPath);
    }

    // Generate summary statistics
    const totalCalls = data.reduce((sum, week) => sum + week.totalCalls, 0);
    const totalSuccessfulCalls = data.reduce((sum, week) => sum + week.successfulCalls, 0);
    const totalDuration = data.reduce((sum, week) => sum + week.totalDuration, 0);
    const totalCost = data.reduce((sum, week) => sum + week.totalCost, 0);

    // Queue email job
    await queueManager.addEmailJob({
      type: 'monthly_report',
      to: process.env.EMAIL_TO?.split(',').map(email => email.trim()) || [],
      subject: `Monthly Call Report - ${new Date(startString).toLocaleDateString()} to ${new Date(endString).toLocaleDateString()} (User: ${userId})`,
      html: `
        <h2>📞 Monthly Call Report</h2>
        <p>User: ${userId}</p>
        <p>Period: ${new Date(startString).toLocaleDateString()} to ${new Date(endString).toLocaleDateString()}</p>
        <p>Total Calls: ${totalCalls}</p>
        <p>Successful Calls: ${totalSuccessfulCalls}</p>
        <p>Success Rate: ${totalCalls > 0 ? ((totalSuccessfulCalls / totalCalls) * 100).toFixed(1) : 0}%</p>
        <p>Average Call Duration: ${(totalDuration / totalCalls).toFixed(1)} seconds</p>
        <p>Total Cost: $${totalCost.toFixed(2)}</p>
        <h3>Weekly Breakdown:</h3>
        <ul>
          ${data.map(week => `
            <li>
              Week ${week._id.week}: ${week.totalCalls} calls (${week.successfulCalls} successful)
              - Avg Duration: ${(week.totalDuration / week.totalCalls).toFixed(1)}s
              - Cost: $${week.totalCost.toFixed(2)}
            </li>
          `).join('')}
        </ul>
        <p>Please find the detailed reports attached.</p>
      `,
      filePaths,
      metadata: { cleanup: true }
    });

    return {
      status: 'completed',
      userId,
      totalCalls,
      successfulCalls: totalSuccessfulCalls,
      averageDuration: totalDuration / totalCalls,
      totalCost,
      reportsGenerated: filePaths.length
    };
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