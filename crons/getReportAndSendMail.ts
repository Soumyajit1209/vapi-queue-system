
import mongoose from "mongoose";
import dotenv from "dotenv";
import { connectDB } from "../src/connectDB";
import CallData from "../src/models/callData.model";
import { QueueManager } from "../src/queues/QueueManager";
import { generateAdvancedReport, generateSummaryStats } from "../src/reportGenerator";

dotenv.config();

const EMAIL_TO: string[] = process.env.EMAIL_TO?.split(',').map(email => email.trim()) as string[];

function getTodayDateRange() {
    const end = new Date(); // current time
    const endString = end.toISOString();

    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago
    const startString = start.toISOString();

    return { startString, endString };
}

async function fetchTodayFullCallData() {
    const { startString, endString } = getTodayDateRange();

    const users = await CallData.aggregate([
        {
            $match: {
                userId: "user_2x0DhdwrWfE9PpFSljdOd3aOvYG",
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
                call: {
                    id: 1,
                    type: 1,
                    phoneNumber: 1
                },
                customer: {
                    name: 1,
                    number: 1
                },
                assistant: {
                    id: 1,
                    name: 1
                }
            }
        }
    ]);

    return users || [];
}

async function main() {
    try {
        await connectDB();

        const data = await fetchTodayFullCallData();

        if (!data?.length) {
            console.log("No calls found for the date range.");
            
            // Still send an email notification about no calls
            const queueManager = QueueManager.getInstance();
            await queueManager.addEmailJob({
                type: 'daily_report',
                to: EMAIL_TO,
                subject: `Daily Call Report - ${new Date().toLocaleDateString()} - No Calls`,
                html: `
                    <h2>📞 Daily Call Report</h2>
                    <p>Date: ${new Date().toLocaleDateString()}</p>
                    <p><strong>No calls were made in the last 24 hours.</strong></p>
                    <p>This could be normal if it's outside business hours or a weekend.</p>
                `,
                metadata: { cleanup: false }
            });
            
            return;
        }

        // Generate comprehensive statistics
        const stats = generateSummaryStats(data);

        // Generate advanced report with multiple sheets
        const advancedReportPath = generateAdvancedReport(data, "DailyReport_Comprehensive");

        // Filter successful calls for separate report
        const successfulCalls = data.filter((call: any) =>
            call.analysis?.successEvaluation === true &&
            call.durationSeconds > 10 &&
            call.endedReason?.toLowerCase() !== "voicemail"
        );

        const filePaths = [advancedReportPath];

        // Generate successful calls report if there are any
        if (successfulCalls.length > 0) {
            const successfulReportPath = generateAdvancedReport(successfulCalls, "DailyReport_SuccessfulCalls");
            filePaths.push(successfulReportPath);
        }

        // Generate detailed HTML email content
        const emailHtml = generateEmailContent(stats, data.length, successfulCalls.length);

        // Queue email job using BullMQ
        const queueManager = QueueManager.getInstance();
        await queueManager.addEmailJob({
            type: 'daily_report',
            to: EMAIL_TO,
            subject: `📞 Daily Call Report - ${new Date().toLocaleDateString()} (${stats.successRate}% Success Rate)`,
            html: emailHtml,
            filePaths: filePaths,
            metadata: { 
                cleanup: true, // Clean up files after sending
                reportDate: new Date().toLocaleDateString(),
                totalCalls: data.length,
                successfulCalls: successfulCalls.length
            }
        });

        console.log(`✅ Daily report queued successfully - ${data.length} calls processed`);

    } catch (err) {
        console.error("❌ Error generating daily report:", err);
        
        // Send error notification
        try {
            const queueManager = QueueManager.getInstance();
            await queueManager.addEmailJob({
                type: 'alert',
                to: EMAIL_TO,
                subject: '🚨 Daily Report Generation Failed',
                html: `
                    <h2>🚨 Daily Report Generation Error</h2>
                    <p>The daily call report generation failed with the following error:</p>
                    <pre style="background-color: #f5f5f5; padding: 10px; border-radius: 5px;">
                        ${err instanceof Error ? err.message : String(err)}
                    </pre>
                    <p>Timestamp: ${new Date().toISOString()}</p>
                    <p>Please check the application logs for more details.</p>
                `,
                metadata: { cleanup: false }
            });
        } catch (emailError) {
            console.error("❌ Failed to send error notification:", emailError);
        }
    } finally {
        await mongoose.disconnect();
    }
}

function generateEmailContent(stats: any, totalCalls: number, successfulCalls: number): string {
    const successRate = totalCalls > 0 ? ((successfulCalls / totalCalls) * 100).toFixed(1) : '0';
    
    return `
        <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #333; text-align: center; border-bottom: 3px solid #4CAF50; padding-bottom: 10px;">
                📞 Daily Call Report
            </h1>
            
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h2 style="color: #495057; margin-top: 0;">📊 Summary Statistics</h2>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
                    <div style="background: white; padding: 15px; border-radius: 6px; border-left: 4px solid #007bff;">
                        <h3 style="margin: 0; color: #007bff;">Total Calls</h3>
                        <p style="font-size: 24px; font-weight: bold; margin: 5px 0 0 0;">${stats.totalCalls}</p>
                    </div>
                    <div style="background: white; padding: 15px; border-radius: 6px; border-left: 4px solid #28a745;">
                        <h3 style="margin: 0; color: #28a745;">Successful Calls</h3>
                        <p style="font-size: 24px; font-weight: bold; margin: 5px 0 0 0;">${stats.successfulCalls}</p>
                    </div>
                    <div style="background: white; padding: 15px; border-radius: 6px; border-left: 4px solid #17a2b8;">
                        <h3 style="margin: 0; color: #17a2b8;">Success Rate</h3>
                        <p style="font-size: 24px; font-weight: bold; margin: 5px 0 0 0;">${stats.successRate}%</p>
                    </div>
                    <div style="background: white; padding: 15px; border-radius: 6px; border-left: 4px solid #ffc107;">
                        <h3 style="margin: 0; color: #ffc107;">Total Cost</h3>
                        <p style="font-size: 24px; font-weight: bold; margin: 5px 0 0 0;">${stats.totalCost}</p>
                    </div>
                </div>
            </div>

            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h2 style="color: #495057; margin-top: 0;">⏱️ Duration & Performance</h2>
                <ul style="list-style: none; padding: 0;">
                    <li style="padding: 8px 0; border-bottom: 1px solid #dee2e6;">
                        <strong>Total Talk Time:</strong> ${stats.totalDuration}
                    </li>
                    <li style="padding: 8px 0; border-bottom: 1px solid #dee2e6;">
                        <strong>Average Call Duration:</strong> ${stats.avgDuration}
                    </li>
                    <li style="padding: 8px 0; border-bottom: 1px solid #dee2e6;">
                        <strong>Average Cost per Call:</strong> ${stats.avgCost}
                    </li>
                </ul>
            </div>

            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h2 style="color: #495057; margin-top: 0;">📊 Call Outcomes</h2>
                <div style="margin: 15px 0;">
                    ${Object.entries(stats.endReasonBreakdown).map(([reason, count]) => `
                        <div style="margin: 8px 0; padding: 8px; background: white; border-radius: 4px;">
                            <span style="font-weight: bold;">${reason}:</span> 
                            <span>${count} calls (${((count as number / totalCalls) * 100).toFixed(1)}%)</span>
                        </div>
                    `).join('')}
                </div>
            </div>

            ${Object.keys(stats.assistantBreakdown).length > 1 ? `
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h2 style="color: #495057; margin-top: 0;">🤖 Assistant Performance</h2>
                <div style="margin: 15px 0;">
                    ${Object.entries(stats.assistantBreakdown).map(([assistant, count]) => `
                        <div style="margin: 8px 0; padding: 8px; background: white; border-radius: 4px;">
                            <span style="font-weight: bold;">${assistant}:</span> 
                            <span>${count} calls</span>
                        </div>
                    `).join('')}
                </div>
            </div>
            ` : ''}

            <div style="background-color: #e9ecef; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <h3 style="color: #495057; margin-top: 0;">📎 Attached Reports</h3>
                <ul>
                    <li>📈 Comprehensive Daily Report (Multiple sheets with detailed analytics)</li>
                    ${successfulCalls > 0 ? '<li>✅ Successful Calls Report (Filtered successful calls only)</li>' : ''}
                </ul>
            </div>

            <div style="text-align: center; margin-top: 30px; padding: 20px; border-top: 1px solid #dee2e6;">
                <p style="color: #6c757d; margin: 0;">
                    Report generated on ${new Date().toLocaleString()}
                </p>
                <p style="color: #6c757d; margin: 5px 0 0 0; font-size: 14px;">
                    Powered by azmth Call Management System
                </p>
            </div>
        </div>
    `;
}

// Run if called directly
if (require.main === module) {
    main();
}