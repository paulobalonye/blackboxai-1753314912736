import { Service, ServiceBroker, Context } from 'moleculer';
import { z } from 'zod';
import config from '../config';

// Validation schemas
const SendEmailSchema = z.object({
  to: z.string().email('Invalid email address'),
  subject: z.string().min(1, 'Subject is required'),
  message: z.string().min(1, 'Message is required'),
  html: z.string().optional()
});

const SendSMSSchema = z.object({
  to: z.string().min(1, 'Phone number is required'),
  message: z.string().min(1, 'Message is required').max(160, 'SMS message too long')
});

const SendPushNotificationSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  title: z.string().min(1, 'Title is required'),
  message: z.string().min(1, 'Message is required'),
  data: z.record(z.any()).optional()
});

export default class NotificationService extends Service {
  public constructor(broker: ServiceBroker) {
    super(broker);
    
    this.parseServiceSchema({
      name: 'notification',
      version: 1,
      
      settings: {
        twilio: config.twilio,
        sendgrid: config.sendgrid
      },
      
      actions: {
        // Send email
        sendEmail: {
          handler: this.sendEmail
        },
        
        // Send SMS
        sendSMS: {
          handler: this.sendSMS
        },
        
        // Send push notification
        sendPushNotification: {
          handler: this.sendPushNotification
        },
        
        // Send welcome email
        sendWelcomeEmail: {
          handler: this.sendWelcomeEmail
        },
        
        // Send ride notifications
        sendRideRequestNotification: {
          handler: this.sendRideRequestNotification
        },
        
        sendRideAcceptedNotification: {
          handler: this.sendRideAcceptedNotification
        },
        
        sendRideCompletedNotification: {
          handler: this.sendRideCompletedNotification
        },
        
        // Send driver approval notifications
        sendDriverApprovedNotification: {
          handler: this.sendDriverApprovedNotification
        },
        
        sendDriverRejectedNotification: {
          handler: this.sendDriverRejectedNotification
        }
      },
      
      methods: {
        sendEmailViaSendGrid: this.sendEmailViaSendGrid,
        sendSMSViaTwilio: this.sendSMSViaTwilio,
        sendPushViaFirebase: this.sendPushViaFirebase,
        formatPhoneNumber: this.formatPhoneNumber
      },
      
      events: {
        'user.created': this.onUserCreated,
        'driver.registered': this.onDriverRegistered,
        'driver.approved': this.onDriverApproved,
        'driver.rejected': this.onDriverRejected,
        'ride.requested': this.onRideRequested,
        'ride.accepted': this.onRideAccepted,
        'ride.completed': this.onRideCompleted,
        'ride.cancelled': this.onRideCancelled
      }
    });
  }
  
  /**
   * Send email
   */
  public async sendEmail(ctx: Context): Promise<{ success: boolean; messageId?: string }> {
    try {
      const { to, subject, message, html } = SendEmailSchema.parse(ctx.params);
      
      const result = await this.sendEmailViaSendGrid({
        to,
        subject,
        text: message,
        html: html || message
      });
      
      this.logger.info(`Email sent to ${to}: ${subject}`);
      
      return {
        success: true,
        messageId: result.messageId
      };
      
    } catch (error) {
      this.logger.error('Send email error:', error);
      return {
        success: false
      };
    }
  }
  
  /**
   * Send SMS
   */
  public async sendSMS(ctx: Context): Promise<{ success: boolean; messageId?: string }> {
    try {
      const { to, message } = SendSMSSchema.parse(ctx.params);
      
      const formattedPhone = this.formatPhoneNumber(to);
      const result = await this.sendSMSViaTwilio(formattedPhone, message);
      
      this.logger.info(`SMS sent to ${formattedPhone}: ${message.substring(0, 50)}...`);
      
      return {
        success: true,
        messageId: result.sid
      };
      
    } catch (error) {
      this.logger.error('Send SMS error:', error);
      return {
        success: false
      };
    }
  }
  
  /**
   * Send push notification
   */
  public async sendPushNotification(ctx: Context): Promise<{ success: boolean }> {
    try {
      const { userId, title, message, data } = SendPushNotificationSchema.parse(ctx.params);
      
      // Get user's device tokens (in real implementation, you'd store these in database)
      const deviceTokens = await this.getUserDeviceTokens(userId);
      
      if (deviceTokens.length === 0) {
        this.logger.warn(`No device tokens found for user: ${userId}`);
        return { success: false };
      }
      
      const result = await this.sendPushViaFirebase({
        tokens: deviceTokens,
        title,
        body: message,
        data
      });
      
      this.logger.info(`Push notification sent to user ${userId}: ${title}`);
      
      return {
        success: true
      };
      
    } catch (error) {
      this.logger.error('Send push notification error:', error);
      return {
        success: false
      };
    }
  }
  
  /**
   * Send welcome email
   */
  public async sendWelcomeEmail(ctx: Context<{ user: any }>): Promise<{ success: boolean }> {
    const { user } = ctx.params;
    
    try {
      const subject = 'Welcome to RideShare!';
      const message = `
        Hi ${user.firstName},
        
        Welcome to RideShare! We're excited to have you on board.
        
        ${user.role === 'driver' ? 
          'Your driver application is being reviewed. You\'ll receive an email once it\'s approved.' :
          'You can now start booking rides with our trusted drivers.'
        }
        
        If you have any questions, feel free to contact our support team.
        
        Best regards,
        The RideShare Team
      `;
      
      await this.sendEmailViaSendGrid({
        to: user.email,
        subject,
        text: message,
        html: message.replace(/\n/g, '<br>')
      });
      
      return { success: true };
      
    } catch (error) {
      this.logger.error('Send welcome email error:', error);
      return { success: false };
    }
  }
  
  /**
   * Send ride request notification
   */
  public async sendRideRequestNotification(ctx: Context<{ driverId: string; trip: any }>): Promise<{ success: boolean }> {
    const { driverId, trip } = ctx.params;
    
    try {
      // Get driver info
      const driver = await this.broker.call('driver.findById', { driverId });
      if (!driver) {
        return { success: false };
      }
      
      const user = await this.broker.call('user.findById', { userId: driver.userId });
      if (!user) {
        return { success: false };
      }
      
      // Send push notification
      await this.sendPushNotification({
        userId: driver.userId,
        title: 'New Ride Request',
        message: `Pickup: ${trip.pickupLocation.address}`,
        data: {
          type: 'ride_request',
          tripId: trip._id,
          fare: trip.fareBreakdown.totalFare
        }
      } as any);
      
      // Send SMS if enabled
      if (user.phone) {
        await this.sendSMSViaTwilio(
          user.phone,
          `New ride request! Pickup: ${trip.pickupLocation.address}. Fare: $${trip.fareBreakdown.totalFare}`
        );
      }
      
      return { success: true };
      
    } catch (error) {
      this.logger.error('Send ride request notification error:', error);
      return { success: false };
    }
  }
  
  /**
   * Send ride accepted notification
   */
  public async sendRideAcceptedNotification(ctx: Context<{ trip: any; driver: any }>): Promise<{ success: boolean }> {
    const { trip, driver } = ctx.params;
    
    try {
      // Get passenger info
      const passenger = await this.broker.call('user.findById', { userId: trip.passengerId });
      if (!passenger) {
        return { success: false };
      }
      
      const driverUser = await this.broker.call('user.findById', { userId: driver.userId });
      if (!driverUser) {
        return { success: false };
      }
      
      // Send push notification to passenger
      await this.sendPushNotification({
        userId: trip.passengerId,
        title: 'Ride Accepted!',
        message: `${driverUser.firstName} is coming to pick you up`,
        data: {
          type: 'ride_accepted',
          tripId: trip._id,
          driverName: driverUser.firstName,
          driverPhone: driverUser.phone,
          vehicle: `${driver.vehicle.color} ${driver.vehicle.make} ${driver.vehicle.model}`,
          licensePlate: driver.vehicle.licensePlate
        }
      } as any);
      
      // Send SMS to passenger
      if (passenger.phone) {
        await this.sendSMSViaTwilio(
          passenger.phone,
          `Your ride has been accepted! ${driverUser.firstName} is driving a ${driver.vehicle.color} ${driver.vehicle.make} (${driver.vehicle.licensePlate})`
        );
      }
      
      return { success: true };
      
    } catch (error) {
      this.logger.error('Send ride accepted notification error:', error);
      return { success: false };
    }
  }
  
  /**
   * Send ride completed notification
   */
  public async sendRideCompletedNotification(ctx: Context<{ trip: any }>): Promise<{ success: boolean }> {
    const { trip } = ctx.params;
    
    try {
      // Get passenger info
      const passenger = await this.broker.call('user.findById', { userId: trip.passengerId });
      if (!passenger) {
        return { success: false };
      }
      
      // Send push notification
      await this.sendPushNotification({
        userId: trip.passengerId,
        title: 'Trip Completed',
        message: `Your trip to ${trip.dropoffLocation.address} is complete`,
        data: {
          type: 'trip_completed',
          tripId: trip._id,
          fare: trip.fareBreakdown.totalFare
        }
      } as any);
      
      // Send email receipt
      const subject = 'Trip Receipt - RideShare';
      const message = `
        Hi ${passenger.firstName},
        
        Your trip has been completed successfully!
        
        Trip Details:
        - From: ${trip.pickupLocation.address}
        - To: ${trip.dropoffLocation.address}
        - Distance: ${trip.actualDistance || trip.estimatedDistance} km
        - Duration: ${trip.getDuration()} minutes
        - Fare: $${trip.fareBreakdown.totalFare}
        
        Thank you for using RideShare!
        
        Best regards,
        The RideShare Team
      `;
      
      await this.sendEmailViaSendGrid({
        to: passenger.email,
        subject,
        text: message,
        html: message.replace(/\n/g, '<br>')
      });
      
      return { success: true };
      
    } catch (error) {
      this.logger.error('Send ride completed notification error:', error);
      return { success: false };
    }
  }
  
  /**
   * Send driver approved notification
   */
  public async sendDriverApprovedNotification(ctx: Context<{ driver: any }>): Promise<{ success: boolean }> {
    const { driver } = ctx.params;
    
    try {
      const user = await this.broker.call('user.findById', { userId: driver.userId });
      if (!user) {
        return { success: false };
      }
      
      const subject = 'Driver Application Approved!';
      const message = `
        Hi ${user.firstName},
        
        Congratulations! Your driver application has been approved.
        
        You can now start accepting ride requests and earning money with RideShare.
        
        Vehicle Details:
        - ${driver.vehicle.year} ${driver.vehicle.make} ${driver.vehicle.model}
        - License Plate: ${driver.vehicle.licensePlate}
        
        To get started:
        1. Open the RideShare Driver app
        2. Go online to start receiving ride requests
        3. Accept rides and start earning!
        
        Welcome to the RideShare driver community!
        
        Best regards,
        The RideShare Team
      `;
      
      await this.sendEmailViaSendGrid({
        to: user.email,
        subject,
        text: message,
        html: message.replace(/\n/g, '<br>')
      });
      
      // Send push notification
      await this.sendPushNotification({
        userId: driver.userId,
        title: 'Application Approved!',
        message: 'You can now start accepting rides',
        data: {
          type: 'driver_approved'
        }
      } as any);
      
      return { success: true };
      
    } catch (error) {
      this.logger.error('Send driver approved notification error:', error);
      return { success: false };
    }
  }
  
  /**
   * Send driver rejected notification
   */
  public async sendDriverRejectedNotification(ctx: Context<{ driver: any; reason: string }>): Promise<{ success: boolean }> {
    const { driver, reason } = ctx.params;
    
    try {
      const user = await this.broker.call('user.findById', { userId: driver.userId });
      if (!user) {
        return { success: false };
      }
      
      const subject = 'Driver Application Update';
      const message = `
        Hi ${user.firstName},
        
        Thank you for your interest in becoming a RideShare driver.
        
        Unfortunately, we cannot approve your application at this time.
        
        Reason: ${reason}
        
        You can reapply after addressing the issues mentioned above.
        
        If you have any questions, please contact our support team.
        
        Best regards,
        The RideShare Team
      `;
      
      await this.sendEmailViaSendGrid({
        to: user.email,
        subject,
        text: message,
        html: message.replace(/\n/g, '<br>')
      });
      
      return { success: true };
      
    } catch (error) {
      this.logger.error('Send driver rejected notification error:', error);
      return { success: false };
    }
  }
  
  /**
   * Send email via SendGrid
   */
  private async sendEmailViaSendGrid(emailData: { to: string; subject: string; text: string; html: string }): Promise<any> {
    try {
      // Mock SendGrid implementation
      // In real implementation, use @sendgrid/mail
      const mockResult = {
        messageId: `msg_${Date.now()}`,
        status: 'sent'
      };
      
      this.logger.info(`Mock email sent to ${emailData.to}: ${emailData.subject}`);
      
      return mockResult;
    } catch (error) {
      throw new Error(`SendGrid error: ${error}`);
    }
  }
  
  /**
   * Send SMS via Twilio
   */
  private async sendSMSViaTwilio(to: string, message: string): Promise<any> {
    try {
      // Mock Twilio implementation
      // In real implementation, use twilio SDK
      const mockResult = {
        sid: `SM${Date.now()}`,
        status: 'sent',
        to,
        from: config.twilio.phoneNumber
      };
      
      this.logger.info(`Mock SMS sent to ${to}: ${message.substring(0, 50)}...`);
      
      return mockResult;
    } catch (error) {
      throw new Error(`Twilio error: ${error}`);
    }
  }
  
  /**
   * Send push notification via Firebase
   */
  private async sendPushViaFirebase(notificationData: { tokens: string[]; title: string; body: string; data?: any }): Promise<any> {
    try {
      // Mock Firebase implementation
      // In real implementation, use firebase-admin
      const mockResult = {
        successCount: notificationData.tokens.length,
        failureCount: 0,
        responses: notificationData.tokens.map(token => ({
          success: true,
          messageId: `msg_${Date.now()}_${token.slice(-6)}`
        }))
      };
      
      this.logger.info(`Mock push notification sent to ${notificationData.tokens.length} devices: ${notificationData.title}`);
      
      return mockResult;
    } catch (error) {
      throw new Error(`Firebase error: ${error}`);
    }
  }
  
  /**
   * Format phone number
   */
  private formatPhoneNumber(phone: string): string {
    // Remove all non-digit characters
    const cleaned = phone.replace(/\D/g, '');
    
    // Add country code if not present
    if (cleaned.length === 10) {
      return `+1${cleaned}`;
    } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
      return `+${cleaned}`;
    }
    
    return phone; // Return as-is if already formatted
  }
  
  /**
   * Get user device tokens (mock implementation)
   */
  private async getUserDeviceTokens(userId: string): Promise<string[]> {
    // In real implementation, fetch from database
    return [`token_${userId}_device1`, `token_${userId}_device2`];
  }
  
  // Event handlers
  private async onUserCreated(payload: { user: any }): Promise<void> {
    await this.sendWelcomeEmail({ user: payload.user } as any);
  }
  
  private async onDriverRegistered(payload: { driver: any }): Promise<void> {
    this.logger.info(`Driver registration notification sent for: ${payload.driver.userId}`);
  }
  
  private async onDriverApproved(payload: { driver: any }): Promise<void> {
    await this.sendDriverApprovedNotification({ driver: payload.driver } as any);
  }
  
  private async onDriverRejected(payload: { driver: any; reason: string }): Promise<void> {
    await this.sendDriverRejectedNotification({ driver: payload.driver, reason: payload.reason } as any);
  }
  
  private async onRideRequested(payload: { trip: any; nearbyDrivers: string[] }): Promise<void> {
    // Notify all nearby drivers
    for (const driverId of payload.nearbyDrivers) {
      await this.sendRideRequestNotification({ driverId, trip: payload.trip } as any);
    }
  }
  
  private async onRideAccepted(payload: { trip: any; driver: any }): Promise<void> {
    await this.sendRideAcceptedNotification({ trip: payload.trip, driver: payload.driver } as any);
  }
  
  private async onRideCompleted(payload: { trip: any }): Promise<void> {
    await this.sendRideCompletedNotification({ trip: payload.trip } as any);
  }
  
  private async onRideCancelled(payload: { trip: any; reason: string }): Promise<void> {
    this.logger.info(`Ride cancelled notification: ${payload.trip._id} - ${payload.reason}`);
    // Could send cancellation notifications here
  }
}
