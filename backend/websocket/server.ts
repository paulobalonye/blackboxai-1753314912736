import { Server as SocketIOServer, Socket } from 'socket.io';
import { createServer } from 'http';
import jwt from 'jsonwebtoken';
import config from '../config';
import { UserRole } from '../models/User.model';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userRole?: UserRole;
  driverId?: string;
}

interface JWTPayload {
  userId: string;
  email: string;
  role: UserRole;
}

export class WebSocketServer {
  private io: SocketIOServer;
  private server: any;
  private connectedUsers: Map<string, string> = new Map(); // userId -> socketId
  private connectedDrivers: Map<string, string> = new Map(); // driverId -> socketId

  constructor(port: number = config.socketPort) {
    this.server = createServer();
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      },
      transports: ['websocket', 'polling']
    });

    this.setupMiddleware();
    this.setupEventHandlers();
    
    this.server.listen(port, () => {
      console.log(`🔌 WebSocket server running on port ${port}`);
    });
  }

  /**
   * Setup authentication middleware
   */
  private setupMiddleware(): void {
    this.io.use(async (socket: any, next) => {
      try {
        const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
          return next(new Error('Authentication token required'));
        }

        const decoded = jwt.verify(token, config.jwtSecret) as JWTPayload;
        
        socket.userId = decoded.userId;
        socket.userRole = decoded.role;
        
        // If user is a driver, get driver ID
        if (decoded.role === UserRole.DRIVER) {
          // In a real implementation, you'd query the database
          // For now, we'll use a mock driver ID
          socket.driverId = `driver_${decoded.userId}`;
        }
        
        next();
      } catch (error) {
        next(new Error('Invalid authentication token'));
      }
    });
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    this.io.on('connection', (socket: AuthenticatedSocket) => {
      console.log(`User connected: ${socket.userId} (${socket.userRole})`);
      
      // Store connection
      if (socket.userId) {
        this.connectedUsers.set(socket.userId, socket.id);
        
        if (socket.driverId) {
          this.connectedDrivers.set(socket.driverId, socket.id);
        }
      }

      // Join user to their personal room
      if (socket.userId) {
        socket.join(`user_${socket.userId}`);
        
        if (socket.userRole === UserRole.DRIVER && socket.driverId) {
          socket.join(`driver_${socket.driverId}`);
        }
      }

      // Handle driver location updates
      socket.on('driver:updateLocation', (data) => {
        this.handleDriverLocationUpdate(socket, data);
      });

      // Handle driver availability updates
      socket.on('driver:updateAvailability', (data) => {
        this.handleDriverAvailabilityUpdate(socket, data);
      });

      // Handle trip status updates
      socket.on('trip:updateStatus', (data) => {
        this.handleTripStatusUpdate(socket, data);
      });

      // Handle ride request responses
      socket.on('ride:respond', (data) => {
        this.handleRideResponse(socket, data);
      });

      // Handle chat messages
      socket.on('chat:message', (data) => {
        this.handleChatMessage(socket, data);
      });

      // Handle typing indicators
      socket.on('chat:typing', (data) => {
        this.handleTypingIndicator(socket, data);
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        this.handleDisconnection(socket);
      });
    });
  }

  /**
   * Handle driver location updates
   */
  private handleDriverLocationUpdate(socket: AuthenticatedSocket, data: any): void {
    if (socket.userRole !== UserRole.DRIVER) {
      socket.emit('error', { message: 'Only drivers can update location' });
      return;
    }

    const { latitude, longitude, heading, speed } = data;

    if (!latitude || !longitude) {
      socket.emit('error', { message: 'Latitude and longitude are required' });
      return;
    }

    // Broadcast location update to passengers in active trips
    this.broadcastDriverLocationToPassengers(socket.driverId!, {
      driverId: socket.driverId,
      location: {
        latitude,
        longitude,
        heading,
        speed,
        timestamp: new Date()
      }
    });

    console.log(`Driver ${socket.driverId} location updated: ${latitude}, ${longitude}`);
  }

  /**
   * Handle driver availability updates
   */
  private handleDriverAvailabilityUpdate(socket: AuthenticatedSocket, data: any): void {
    if (socket.userRole !== UserRole.DRIVER) {
      socket.emit('error', { message: 'Only drivers can update availability' });
      return;
    }

    const { availability } = data;

    // Broadcast availability update
    socket.broadcast.emit('driver:availabilityUpdated', {
      driverId: socket.driverId,
      availability,
      timestamp: new Date()
    });

    console.log(`Driver ${socket.driverId} availability updated: ${availability}`);
  }

  /**
   * Handle trip status updates
   */
  private handleTripStatusUpdate(socket: AuthenticatedSocket, data: any): void {
    const { tripId, status, location } = data;

    if (!tripId || !status) {
      socket.emit('error', { message: 'Trip ID and status are required' });
      return;
    }

    // Broadcast to all participants in the trip
    this.io.to(`trip_${tripId}`).emit('trip:statusUpdated', {
      tripId,
      status,
      location,
      updatedBy: socket.userId,
      timestamp: new Date()
    });

    console.log(`Trip ${tripId} status updated to ${status} by ${socket.userId}`);
  }

  /**
   * Handle ride request responses
   */
  private handleRideResponse(socket: AuthenticatedSocket, data: any): void {
    if (socket.userRole !== UserRole.DRIVER) {
      socket.emit('error', { message: 'Only drivers can respond to ride requests' });
      return;
    }

    const { tripId, response, estimatedArrival } = data;

    if (!tripId || !response) {
      socket.emit('error', { message: 'Trip ID and response are required' });
      return;
    }

    // Notify the passenger
    this.io.to(`trip_${tripId}`).emit('ride:response', {
      tripId,
      driverId: socket.driverId,
      response,
      estimatedArrival,
      timestamp: new Date()
    });

    console.log(`Driver ${socket.driverId} responded to trip ${tripId}: ${response}`);
  }

  /**
   * Handle chat messages
   */
  private handleChatMessage(socket: AuthenticatedSocket, data: any): void {
    const { tripId, message, type = 'text' } = data;

    if (!tripId || !message) {
      socket.emit('error', { message: 'Trip ID and message are required' });
      return;
    }

    const chatMessage = {
      id: `msg_${Date.now()}`,
      tripId,
      senderId: socket.userId,
      senderRole: socket.userRole,
      message,
      type,
      timestamp: new Date()
    };

    // Broadcast to all participants in the trip
    this.io.to(`trip_${tripId}`).emit('chat:message', chatMessage);

    console.log(`Chat message in trip ${tripId} from ${socket.userId}: ${message.substring(0, 50)}...`);
  }

  /**
   * Handle typing indicators
   */
  private handleTypingIndicator(socket: AuthenticatedSocket, data: any): void {
    const { tripId, isTyping } = data;

    if (!tripId) {
      socket.emit('error', { message: 'Trip ID is required' });
      return;
    }

    // Broadcast typing indicator to other participants
    socket.to(`trip_${tripId}`).emit('chat:typing', {
      tripId,
      userId: socket.userId,
      userRole: socket.userRole,
      isTyping,
      timestamp: new Date()
    });
  }

  /**
   * Handle disconnection
   */
  private handleDisconnection(socket: AuthenticatedSocket): void {
    console.log(`User disconnected: ${socket.userId}`);

    if (socket.userId) {
      this.connectedUsers.delete(socket.userId);
    }

    if (socket.driverId) {
      this.connectedDrivers.delete(socket.driverId);
    }
  }

  /**
   * Broadcast driver location to passengers in active trips
   */
  private broadcastDriverLocationToPassengers(driverId: string, locationData: any): void {
    // In a real implementation, you'd query the database for active trips
    // and notify only the passengers in those trips
    this.io.emit('driver:locationUpdated', locationData);
  }

  /**
   * Public methods for external services to emit events
   */

  /**
   * Notify user about new ride request
   */
  public notifyRideRequest(driverId: string, tripData: any): void {
    const socketId = this.connectedDrivers.get(driverId);
    if (socketId) {
      this.io.to(socketId).emit('ride:newRequest', {
        trip: tripData,
        timestamp: new Date()
      });
    }
  }

  /**
   * Notify about ride acceptance
   */
  public notifyRideAccepted(tripId: string, driverData: any): void {
    this.io.to(`trip_${tripId}`).emit('ride:accepted', {
      tripId,
      driver: driverData,
      timestamp: new Date()
    });
  }

  /**
   * Notify about ride completion
   */
  public notifyRideCompleted(tripId: string, tripData: any): void {
    this.io.to(`trip_${tripId}`).emit('ride:completed', {
      tripId,
      trip: tripData,
      timestamp: new Date()
    });
  }

  /**
   * Notify about ride cancellation
   */
  public notifyRideCancelled(tripId: string, reason: string, cancelledBy: string): void {
    this.io.to(`trip_${tripId}`).emit('ride:cancelled', {
      tripId,
      reason,
      cancelledBy,
      timestamp: new Date()
    });
  }

  /**
   * Add user to trip room
   */
  public addUserToTripRoom(userId: string, tripId: string): void {
    const socketId = this.connectedUsers.get(userId);
    if (socketId) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) {
        socket.join(`trip_${tripId}`);
      }
    }
  }

  /**
   * Remove user from trip room
   */
  public removeUserFromTripRoom(userId: string, tripId: string): void {
    const socketId = this.connectedUsers.get(userId);
    if (socketId) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) {
        socket.leave(`trip_${tripId}`);
      }
    }
  }

  /**
   * Send notification to specific user
   */
  public sendNotificationToUser(userId: string, notification: any): void {
    const socketId = this.connectedUsers.get(userId);
    if (socketId) {
      this.io.to(socketId).emit('notification', {
        ...notification,
        timestamp: new Date()
      });
    }
  }

  /**
   * Broadcast system announcement
   */
  public broadcastSystemAnnouncement(announcement: any): void {
    this.io.emit('system:announcement', {
      ...announcement,
      timestamp: new Date()
    });
  }

  /**
   * Get connected users count
   */
  public getConnectedUsersCount(): number {
    return this.connectedUsers.size;
  }

  /**
   * Get connected drivers count
   */
  public getConnectedDriversCount(): number {
    return this.connectedDrivers.size;
  }

  /**
   * Check if user is connected
   */
  public isUserConnected(userId: string): boolean {
    return this.connectedUsers.has(userId);
  }

  /**
   * Check if driver is connected
   */
  public isDriverConnected(driverId: string): boolean {
    return this.connectedDrivers.has(driverId);
  }

  /**
   * Get server instance for external access
   */
  public getServer(): any {
    return this.server;
  }

  /**
   * Get Socket.IO instance for external access
   */
  public getIO(): SocketIOServer {
    return this.io;
  }

  /**
   * Shutdown the WebSocket server
   */
  public shutdown(): void {
    this.io.close();
    this.server.close();
    console.log('🔌 WebSocket server shut down');
  }
}

// Export singleton instance
export const webSocketServer = new WebSocketServer();
export default webSocketServer;
