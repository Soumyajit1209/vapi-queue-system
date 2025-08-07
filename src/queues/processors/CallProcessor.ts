// src/queues/processors/CallProcessor.ts
import { Job } from 'bullmq';
import { JobData } from '../config';
import { connectDB } from '../../connectDB';
import User, { IUser } from '../../models/User';
import { isVapiBusy, makeCall } from '../../vapiHelpers';
import { isWithinCallHours, delay, getCurrentDayOfWeek, getCurrentTimeSlot } from '../../utils';
import { CallQueueDone } from '../../models/callQueueDone';
import { QueueManager } from '../QueueManager';

export class CallProcessor {
  async process(job: Job<JobData>): Promise<any> {
    const { userId, assistantId, contact, metadata } = job.data;
    
    try {
      await connectDB();
      
      // Get user details
      const user = await User.findById(userId)
        .select("_id clerkId twilioConfig weeklySchedule")
        .lean() as IUser | null;

      if (!user) {
        throw new Error(`User not found: ${userId}`);
      }

      // Check if within call hours for this assistant
      const currentSlot = this.getCurrentSlotForAssistant(user, assistantId);
      if (!currentSlot || !isWithinCallHours(currentSlot.callTimeStart, currentSlot.callTimeEnd)) {
        // Reschedule for next valid time slot
        await this.rescheduleForNextSlot(job, user, assistantId);
        return { status: 'rescheduled', reason: 'outside_call_hours' };
      }

      // Check if VAPI is busy
      if (await isVapiBusy()) {
        // Add delay and retry
        const queueManager = QueueManager.getInstance();
        await queueManager.addCallJob(job.data, { delay: 15000 }); // Retry in 15 seconds
        return { status: 'delayed', reason: 'vapi_busy' };
      }

      // Create record in CallQueueDone for tracking
      const callDoneDoc = await CallQueueDone.create({
        userId,
        agentId: assistantId,
        name: contact.name,
        number: contact.number,
        status: "pending_initiation",
        createdAt: new Date()
      });

      try {
        // Make the call
        await makeCall(user, contact, assistantId);
        
        // Update status to initiated
        await CallQueueDone.updateOne(
          { _id: callDoneDoc._id },
          { 
            $set: { 
              status: "initiated", 
              completedAt: new Date() 
            } 
          }
        );

        console.log(`✅ Call successfully made to ${contact.name} (${contact.number})`);
        
        return {
          status: 'completed',
          callId: callDoneDoc._id,
          contact: contact
        };

      } catch (callError: any) {
        // Update status to failed
        await CallQueueDone.updateOne(
          { _id: callDoneDoc._id },
          {
            $set: {
              status: "failed",
              reason: callError.message || "Unknown error",
              completedAt: new Date()
            }
          }
        );

        throw callError;
      }

    } catch (error: any) {
      console.error(`❌ Call processing failed for ${contact.name}:`, error.message);
      
      // Check if this is a retryable error
      if (this.isRetryableError(error)) {
        throw error; // BullMQ will retry based on job options
      } else {
        // Non-retryable error, mark as permanently failed
        throw new Error(`Permanent failure: ${error.message}`);
      }
    }
  }

  private getCurrentSlotForAssistant(user: IUser, assistantId: string) {
    const currentDay = getCurrentDayOfWeek();
    const daySchedule = user.weeklySchedule?.[currentDay];
    
    if (!daySchedule) return null;

    // Find the slot that matches the assistant ID
    for (const [slotName, slotData] of Object.entries(daySchedule)) {
      if ((slotData as any)?.assistantId === assistantId) {
        return slotData as any;
      }
    }

    return null;
  }

  private async rescheduleForNextSlot(job: Job<JobData>, user: IUser, assistantId: string) {
    const nextSlot = this.findNextAvailableSlot(user, assistantId);
    
    if (nextSlot) {
      const delayMs = this.calculateDelayToNextSlot(nextSlot);
      const queueManager = QueueManager.getInstance();
      
      await queueManager.addCallJob(job.data, { 
        delay: delayMs,
        priority: job.opts.priority || 1 
      });
      
      console.log(`📅 Rescheduled call for ${job.data.contact.name} to next available slot`);
    } else {
      console.warn(`⚠️ No available slots found for assistant ${assistantId}`);
    }
  }

  private findNextAvailableSlot(user: IUser, assistantId: string) {
    // Implementation to find next available time slot for the assistant
    // This would check the weekly schedule and find the next valid time
    const currentDay = getCurrentDayOfWeek();
    const daysToCheck = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const currentDayIndex = daysToCheck.indexOf(currentDay);
    
    // Check remaining days starting from tomorrow
    for (let i = 1; i <= 7; i++) {
      const dayIndex = (currentDayIndex + i) % 7;
      const dayName = daysToCheck[dayIndex];
      const daySchedule = user.weeklySchedule?.[dayName as keyof typeof user.weeklySchedule];
      
      if (daySchedule) {
        for (const [slotName, slotData] of Object.entries(daySchedule)) {
          if ((slotData as any)?.assistantId === assistantId) {
            return {
              day: dayName,
              slot: slotName,
              ...slotData as any
            };
          }
        }
      }
    }
    
    return null;
  }

  private calculateDelayToNextSlot(nextSlot: any): number {
    // Calculate delay in milliseconds to the next available slot
    // This is a simplified implementation
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(parseInt(nextSlot.callTimeStart.split(':')[0]), 
                     parseInt(nextSlot.callTimeStart.split(':')[1]), 0, 0);
    
    return Math.max(0, tomorrow.getTime() - now.getTime());
  }

  private isRetryableError(error: any): boolean {
    // Define which errors should be retried
    const retryableErrors = [
      'VAPI_BUSY',
      'NETWORK_ERROR',
      'TEMPORARY_FAILURE',
      'RATE_LIMITED'
    ];
    
    return retryableErrors.some(retryableError => 
      error.message?.includes(retryableError) || error.code === retryableError
    );
  }
}