// src/utils/reportGenerator.ts
import fs from "fs";
import path from "path";
import xlsx from "json-as-xlsx";
import dayjs from "dayjs";

export interface CallReportData {
  analysis?: {
    successEvaluation?: boolean;
  };
  startedAt?: string;
  cost?: number;
  endedReason?: string;
  durationSeconds?: number;
  summary?: string;
  transcript?: string;
  recordingUrl?: string;
  call?: {
    id?: string;
    type?: string;
    phoneNumber?: {
      twilioPhoneNumber?: string;
    };
  };
  customer?: {
    name?: string;
    number?: string;
  };
  assistant?: {
    id?: string;
    name?: string;
  };
}

export function saveToXLSX(calls: CallReportData[], label: string = "AllCalls"): string {
  if (!calls.length) {
    throw new Error("No calls to export.");
  }

  const data = [
    {
      sheet: "Call Report",
      columns: [
        { label: "Phone Number", value: "phoneNumber" },
        { label: "Customer Name", value: "customerName" },
        { label: "Customer Number", value: "customerNumber" },
        { label: "Duration", value: "duration" },
        { label: "Call Type", value: "callType" },
        { label: "Cost", value: "cost" },
        { label: "Assistant", value: "assistant" },
        { label: "Started At", value: "startedAt" },
        { label: "Ended Reason", value: "endedReason" },
        { label: "Success Evaluation", value: "successEvaluation" },
        { label: "Recording URL", value: "recordingUrl" },
        { label: "Analysis Summary", value: "analysisSummary" },
        { label: "Transcript", value: "transcript" },
      ],
      content: calls.map((call: CallReportData) => ({
        customerNumber: call.customer?.number || "Unknown",
        customerName: call.customer?.name || "Unknown",
        phoneNumber: call.call?.phoneNumber?.twilioPhoneNumber ?? "N/A",
        callType: call.call?.type ?? "N/A",
        successEvaluation: call.analysis?.successEvaluation ?? "N/A",
        cost: formatCurrency(call.cost),
        duration: formatDuration(call.durationSeconds),
        assistant: call.assistant?.name || "N/A",
        startedAt: formatDateTime(call.startedAt),
        endedReason: call.endedReason || "N/A",
        recordingUrl: call.recordingUrl || "N/A",
        analysisSummary: call.summary || "N/A",
        transcript: truncateText(call.transcript, 1000) || "N/A",
      })),
    },
  ];

  const fileName = `${label}_${dayjs().format("YYYY-MM-DD_HH-mm-ss")}`;
  const uploadFolder = ensureUploadsFolder();
  const filePath = path.join(uploadFolder, fileName);

  xlsx(data, {
    fileName: filePath,
    writeMode: "writeFile",
  });

  const fullPath = filePath + ".xlsx";
  console.log(`✅ XLSX "${label}" saved to`, fullPath);
  return fullPath;
}

export function generateSummaryStats(calls: CallReportData[]) {
  const totalCalls = calls.length;
  const successfulCalls = calls.filter(call => 
    call.analysis?.successEvaluation === true &&
    (call.durationSeconds || 0) > 10 &&
    call.endedReason?.toLowerCase() !== "voicemail"
  ).length;

  const totalDuration = calls.reduce((sum, call) => sum + (call.durationSeconds || 0), 0);
  const totalCost = calls.reduce((sum, call) => sum + (call.cost || 0), 0);
  const avgDuration = totalCalls > 0 ? totalDuration / totalCalls : 0;
  const avgCost = totalCalls > 0 ? totalCost / totalCalls : 0;
  const successRate = totalCalls > 0 ? (successfulCalls / totalCalls) * 100 : 0;

  // End reason breakdown
  const endReasonBreakdown = calls.reduce((acc, call) => {
    const reason = call.endedReason || 'unknown';
    acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Assistant breakdown
  const assistantBreakdown = calls.reduce((acc, call) => {
    const assistant = call.assistant?.name || 'unknown';
    acc[assistant] = (acc[assistant] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return {
    totalCalls,
    successfulCalls,
    successRate: Number(successRate.toFixed(2)),
    totalDuration: formatDuration(totalDuration),
    avgDuration: formatDuration(avgDuration),
    totalCost: formatCurrency(totalCost),
    avgCost: formatCurrency(avgCost),
    endReasonBreakdown,
    assistantBreakdown,
    period: {
      start: calls.length > 0 ? calls[0].startedAt : null,
      end: calls.length > 0 ? calls[calls.length - 1].startedAt : null
    }
  };
}

export function generateAdvancedReport(calls: CallReportData[], reportType: string = "Advanced") {
  const stats = generateSummaryStats(calls);
  
  // Create multiple sheets for advanced report
  const data = [
    // Summary sheet
    {
      sheet: "Summary",
      columns: [
        { label: "Metric", value: "metric" },
        { label: "Value", value: "value" }
      ],
      content: [
        { metric: "Total Calls", value: stats.totalCalls },
        { metric: "Successful Calls", value: stats.successfulCalls },
        { metric: "Success Rate", value: `${stats.successRate}%` },
        { metric: "Total Duration", value: stats.totalDuration },
        { metric: "Average Duration", value: stats.avgDuration },
        { metric: "Total Cost", value: stats.totalCost },
        { metric: "Average Cost", value: stats.avgCost }
      ]
    },
    
    // End Reason Breakdown
    {
      sheet: "End Reasons",
      columns: [
        { label: "End Reason", value: "reason" },
        { label: "Count", value: "count" },
        { label: "Percentage", value: "percentage" }
      ],
      content: Object.entries(stats.endReasonBreakdown).map(([reason, count]) => ({
        reason,
        count,
        percentage: `${((count / stats.totalCalls) * 100).toFixed(2)}%`
      }))
    },

    // Assistant Performance
    {
      sheet: "Assistant Performance",
      columns: [
        { label: "Assistant", value: "assistant" },
        { label: "Total Calls", value: "totalCalls" },
        { label: "Success Rate", value: "successRate" },
        { label: "Avg Duration", value: "avgDuration" },
        { label: "Total Cost", value: "totalCost" }
      ],
      content: Object.entries(stats.assistantBreakdown).map(([assistant, totalCalls]) => {
        const assistantCalls = calls.filter(call => (call.assistant?.name || 'unknown') === assistant);
        const successfulCalls = assistantCalls.filter(call => 
          call.analysis?.successEvaluation === true &&
          (call.durationSeconds || 0) > 10 &&
          call.endedReason?.toLowerCase() !== "voicemail"
        ).length;
        
        const totalDuration = assistantCalls.reduce((sum, call) => sum + (call.durationSeconds || 0), 0);
        const totalCost = assistantCalls.reduce((sum, call) => sum + (call.cost || 0), 0);
        
        return {
          assistant,
          totalCalls,
          successRate: totalCalls > 0 ? `${((successfulCalls / totalCalls) * 100).toFixed(2)}%` : '0%',
          avgDuration: formatDuration(totalDuration / totalCalls),
          totalCost: formatCurrency(totalCost)
        };
      })
    },

    // Detailed Call Data
    {
      sheet: "Detailed Calls",
      columns: [
        { label: "Phone Number", value: "phoneNumber" },
        { label: "Customer Name", value: "customerName" },
        { label: "Customer Number", value: "customerNumber" },
        { label: "Duration", value: "duration" },
        { label: "Call Type", value: "callType" },
        { label: "Cost", value: "cost" },
        { label: "Assistant", value: "assistant" },
        { label: "Started At", value: "startedAt" },
        { label: "Ended Reason", value: "endedReason" },
        { label: "Success Evaluation", value: "successEvaluation" },
        { label: "Recording URL", value: "recordingUrl" },
      ],
      content: calls.map((call: CallReportData) => ({
        customerNumber: call.customer?.number || "Unknown",
        customerName: call.customer?.name || "Unknown",
        phoneNumber: call.call?.phoneNumber?.twilioPhoneNumber ?? "N/A",
        callType: call.call?.type ?? "N/A",
        successEvaluation: call.analysis?.successEvaluation ?? "N/A",
        cost: formatCurrency(call.cost),
        duration: formatDuration(call.durationSeconds),
        assistant: call.assistant?.name || "N/A",
        startedAt: formatDateTime(call.startedAt),
        endedReason: call.endedReason || "N/A",
        recordingUrl: call.recordingUrl || "N/A",
      }))
    }
  ];

  const fileName = `${reportType}_${dayjs().format("YYYY-MM-DD_HH-mm-ss")}`;
  const uploadFolder = ensureUploadsFolder();
  const filePath = path.join(uploadFolder, fileName);

  xlsx(data, {
    fileName: filePath,
    writeMode: "writeFile",
  });

  const fullPath = filePath + ".xlsx";
  console.log(`✅ Advanced XLSX "${reportType}" saved to`, fullPath);
  return fullPath;
}

// Helper functions
function ensureUploadsFolder(): string {
  const uploadFolder = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadFolder)) {
    fs.mkdirSync(uploadFolder, { recursive: true });
    console.log(`📁 Created uploads folder at ${uploadFolder}`);
  }
  return uploadFolder;
}

function formatCurrency(amount?: number): string {
  if (amount === undefined || amount === null) return "$0.00";
  return `$${amount.toFixed(2)}`;
}

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "0s";
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${remainingSeconds}s`;
  }
}

function formatDateTime(isoString?: string): string {
  if (!isoString) return "N/A";
  
  try {
    return new Date(isoString).toLocaleString();
  } catch (error) {
    return "Invalid Date";
  }
}

function truncateText(text?: string, maxLength: number = 500): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...";
}