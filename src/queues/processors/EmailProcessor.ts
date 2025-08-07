// src/queues/processors/EmailProcessor.ts
import { Job } from 'bullmq';
import { Resend } from 'resend';
import fs from 'fs';
import path from 'path';

const resend = new Resend(process.env.RESEND_API_KEY);

export interface EmailJobData {
  type: 'daily_report' | 'notification' | 'alert';
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: Array<{
    filename: string;
    content: string;
    contentType?: string;
  }>;
  filePaths?: string[]; // For file attachments
  metadata?: Record<string, any>;
}

export class EmailProcessor {
  async process(job: Job<EmailJobData>): Promise<any> {
    const { type, to, subject, html, text, attachments, filePaths, metadata } = job.data;

    try {
      console.log(`📧 Processing ${type} email job ${job.id}`);

      // Prepare attachments from file paths if provided
      let emailAttachments = attachments || [];

      if (filePaths && filePaths.length > 0) {
        const fileAttachments = filePaths.map(filePath => {
          if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
          }

          return {
            filename: path.basename(filePath),
            content: fs.readFileSync(filePath).toString("base64"),
            contentType: this.getContentType(filePath) 
          };
        });

        emailAttachments = [...emailAttachments, ...fileAttachments];
      }

      // Send email using Resend
      await resend.emails.send({
        from: "GlobalTFN Bot <noreply@mail.globaltfn.tech>",
        to,
        subject,
        html,
        text,
        attachments: emailAttachments.length > 0 ? emailAttachments : undefined,
      } as any)

      if (Error) {
        console.error(`❌ Resend error for job ${job.id}:`, Error);
        throw new Error(`Email sending failed: ${Error || 'Unknown error'}`);
      }

      // Clean up files after successful email if they were temporary
      if (filePaths) {
        this.cleanupFiles(filePaths, metadata?.cleanup !== false);
      }

      console.log(`✅ Email sent successfully - ID: ${data?.id}`);

      return {
        status: 'completed',
        emailId: data?.id,
        sentAt: new Date().toISOString()
      };


      

    } catch (error: any) {
      console.error(`❌ Email job ${job.id} failed:`, error.message);

      // Clean up files even on failure if they were temporary
      if (job.data.filePaths && job.data.metadata?.cleanup !== false) {
        this.cleanupFiles(job.data.filePaths, true);
      }

      throw error;
    }
  }

  private getContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xls': 'application/vnd.ms-excel',
      '.csv': 'text/csv',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.zip': 'application/zip'
    };

    return contentTypes[ext] || 'application/octet-stream';
  }

  private cleanupFiles(filePaths: string[], shouldCleanup: boolean = true) {
    if (!shouldCleanup) return;

    filePaths.forEach(filePath => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`🗑️ Cleaned up file: ${filePath}`);
        }
      } catch (error) {
        console.warn(`⚠️ Failed to cleanup file ${filePath}:`, error);
      }
    });

    // Also try to cleanup the uploads directory if empty
    try {
      const uploadDir = path.join(process.cwd(), 'uploads');
      if (fs.existsSync(uploadDir)) {
        const files = fs.readdirSync(uploadDir);
        if (files.length === 0) {
          fs.rmdirSync(uploadDir);
          console.log('🗑️ Cleaned up empty uploads directory');
        }
      }
    } catch (error) {

    }
  }
}