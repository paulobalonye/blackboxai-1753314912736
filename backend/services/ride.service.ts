import { Service, ServiceBroker, Context } from 'moleculer';
import { z } from 'zod';
import { Trip, ITrip, TripStatus, PaymentMethod, PaymentStatus } from '../models/Trip.model';
import { Driver, DriverStatus, DriverAvailability } from '../models/Driver.model';
import { User, UserRole } from '../models/User.model';

// Validation schemas
const RequestRideSchema = z.object({
  pickupLocation: z.object({
    coordinates: z.array(z.number()).length(2),
    address: z.string().min(1, 'Pickup address is required'),
    placeId: z.string().optional()
  }),
  dropoffLocation: z.object({
    coordinates: z.array(z.number()).length(2),
    address: z.string().min(1, 'Dropoff address is required'),
    placeId: z.string().optional()
  }),
  vehicleType: z.string().min(1, 'Vehicle type is required'),
  paymentMethod: z.enum([PaymentMethod.WALLET, PaymentMethod.CREDIT_CARD, PaymentMethod.CASH]),
  specialInstructions: z.string().max(500).optional()
});

const UpdateTripStatusSchema = z.object({
  status: z.enum([
    TripStatus.ACCEPTED,
    TripStatus.DRIVER_ARRIVED,
    TripStatus.IN_PROGRESS,
    TripStatus.COMPLETED,
    TripStatus.CANCELLED
  ])
});

const RateTripSchema = z.object({
  rating: z.number().min(1).max(5),
  comment: z.string().max(500).optional()
});

export default class RideService extends Service {
  public constructor(broker: ServiceBroker) {
    super(broker);
    
    this.parseServiceSchema({
      name: 'ride',
      version: 1,
      
      actions: {
        // Request a ride
        request: {
          rest: 'POST /request',
          auth: 'required',
          handler: this.requestRide
        },
        
        // Accept a ride (driver)
        accept: {
          rest: 'PUT /:tripId/accept',
          auth: 'required',
          handler: this.acceptRide
        },
        
        // Update trip status
        updateStatus: {
          rest: 'PUT /:tripId/status',
          auth: 'required',
          handler: this.updateTripStatus
        },
        
        // Cancel trip
        cancel: {
          rest: 'PUT /:tripId/cancel',
          auth: 'required',
          handler: this.cancelTrip
        },
        
        // Get trip details
        get: {
          rest: 'GET /:tripId',
          auth: 'required',
          handler: this.getTrip
        },
        
        // Get user's trips
        myTrips: {
          rest: 'GET /my-trips',
          auth: 'required',
          handler: this.getMyTrips
        },
        
        // Get active trip
        active: {
          rest: 'GET /active',
          auth: 'required',
          handler: this.getActiveTrip
        },
        
        // Rate trip
        rate: {
          rest: 'PUT /:tripId/rate',
          auth: 'required',
          handler: this.rateTrip
        },
        
        // Get fare estimate
        estimate: {
          rest: 'POST /estimate',
          handler: this.getFareEstimate
        },
        
        // Admin actions
        list: {
          rest: 'GET /',
          auth: 'required',
          handler: this.listTrips
        },
        
        stats: {
          rest: 'GET /stats',
          auth: 'required',
          handler: this.getTripStats
        },
        
        // Internal actions
        findById: {
          visibility: 'private',
          handler: this.findById
        }
      },
      
      methods: {
        calculateDistance: this.calculateDistance,
        calculateFare: this.calculateFare,
        findNearbyDrivers: this.findNearbyDrivers,
        notifyDrivers: this.notifyDrivers,
        checkUserPermission: this.checkUserPermission,
        checkAdminPermission: this.checkAdminPermission
      },
      
      events: {
        'driver.locationUpdated': this.onDriverLocationUpdated,
        'payment.completed': this.onPaymentCompleted
      }
    });
  }
  
  /**
   * Request a ride
   */
  public async requestRide(ctx: Context): Promise<{ trip: Partial<ITrip>; message: string }> {
    const userId = ctx.meta.user?.userId;
    const userRole = ctx.meta.user?.role;
    
    if (!userId || userRole !== UserRole.PASSENGER) {
      throw new Error('Only passengers can request rides');
    }
    
    try {
      const rideData = RequestRideSchema.parse(ctx.params);
      
      // Check if user has an active trip
      const activeTrip = await Trip.findOne({
        passengerId: userId,
        status: { $in: [TripStatus.REQUESTED, TripStatus.ACCEPTED, TripStatus.DRIVER_ARRIVED, TripStatus.IN_PROGRESS] }
      });
      
      if (activeTrip) {
        throw new Error('You already have an active trip');
      }
      
      // Calculate distance and duration
      const distance = this.calculateDistance(
        rideData.pickupLocation.coordinates[1],
        rideData.pickupLocation.coordinates[0],
        rideData.dropoffLocation.coordinates[1],
        rideData.dropoffLocation.coordinates[0]
      );
      
      const estimatedDuration = Math.max(distance * 2, 5); // Rough estimate: 2 minutes per km, minimum 5 minutes
      
      // Calculate fare
      const fareBreakdown = this.calculateFare(distance, estimatedDuration);
      
      // Create trip
      const trip = new Trip({
        passengerId: userId,
        status: TripStatus.REQUESTED,
        pickupLocation: {
          type: 'Point',
          coordinates: rideData.pickupLocation.coordinates,
          address: rideData.pickupLocation.address,
          placeId: rideData.pickupLocation.placeId
        },
        dropoffLocation: {
          type: 'Point',
          coordinates: rideData.dropoffLocation.coordinates,
          address: rideData.dropoffLocation.address,
          placeId: rideData.dropoffLocation.placeId
        },
        estimatedDistance: distance,
        estimatedDuration: estimatedDuration,
        fareBreakdown,
        paymentMethod: rideData.paymentMethod,
        paymentStatus: PaymentStatus.PENDING,
        vehicleType: rideData.vehicleType,
        specialInstructions: rideData.specialInstructions,
        requestedAt: new Date()
      });
      
      await trip.save();
      
      // Find nearby drivers and notify them
      const nearbyDrivers = await this.findNearbyDrivers(
        rideData.pickupLocation.coordinates[1],
        rideData.pickupLocation.coordinates[0],
        rideData.vehicleType
      );
      
      if (nearbyDrivers.length === 0) {
        throw new Error('No drivers available in your area');
      }
      
      // Notify nearby drivers
      await this.notifyDrivers(nearbyDrivers, trip);
      
      this.logger.info(`Ride requested: ${trip._id} by user ${userId}`);
      
      // Emit ride requested event
      this.broker.emit('ride.requested', {
        trip: trip.toJSON(),
        nearbyDrivers: nearbyDrivers.map(d => d._id)
      });
      
      return {
        trip: trip.toJSON(),
        message: 'Ride requested successfully. Looking for nearby drivers...'
      };
      
    } catch (error) {
      this.logger.error('Request ride error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to request ride');
    }
  }
  
  /**
   * Accept a ride (driver)
   */
  public async acceptRide(ctx: Context): Promise<{ trip: Partial<ITrip>; message: string }> {
    const userId = ctx.meta.user?.userId;
    const userRole = ctx.meta.user?.role;
    const { tripId } = ctx.params as any;
    
    if (!userId || userRole !== UserRole.DRIVER) {
      throw new Error('Only drivers can accept rides');
    }
    
    try {
      // Find driver
      const driver = await Driver.findOne({ userId });
      if (!driver) {
        throw new Error('Driver profile not found');
      }
      
      if (!driver.isAvailableForRide()) {
        throw new Error('Driver is not available for rides');
      }
      
      // Check if driver has an active trip
      const activeTrip = await Trip.findOne({
        driverId: driver._id,
        status: { $in: [TripStatus.ACCEPTED, TripStatus.DRIVER_ARRIVED, TripStatus.IN_PROGRESS] }
      });
      
      if (activeTrip) {
        throw new Error('You already have an active trip');
      }
      
      // Find and update trip
      const trip = await Trip.findById(tripId);
      if (!trip) {
        throw new Error('Trip not found');
      }
      
      if (trip.status !== TripStatus.REQUESTED) {
        throw new Error('Trip is no longer available');
      }
      
      // Accept the trip
      trip.driverId = driver._id;
      trip.updateStatus(TripStatus.ACCEPTED);
      await trip.save();
      
      // Update driver availability
      driver.availability = DriverAvailability.BUSY;
      await driver.save();
      
      this.logger.info(`Ride accepted: ${tripId} by driver ${userId}`);
      
      // Emit ride accepted event
      this.broker.emit('ride.accepted', {
        trip: trip.toJSON(),
        driver: driver.toJSON()
      });
      
      return {
        trip: trip.toJSON(),
        message: 'Ride accepted successfully'
      };
      
    } catch (error) {
      this.logger.error('Accept ride error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to accept ride');
    }
  }
  
  /**
   * Update trip status
   */
  public async updateTripStatus(ctx: Context): Promise<{ trip: Partial<ITrip>; message: string }> {
    const userId = ctx.meta.user?.userId;
    const { tripId } = ctx.params as any;
    const { status } = UpdateTripStatusSchema.parse(ctx.params);
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const trip = await Trip.findById(tripId).populate('driverId');
      if (!trip) {
        throw new Error('Trip not found');
      }
      
      // Check permissions
      const isPassenger = trip.passengerId.toString() === userId;
      const isDriver = trip.driverId && (trip.driverId as any).userId.toString() === userId;
      
      if (!isPassenger && !isDriver) {
        throw new Error('You are not authorized to update this trip');
      }
      
      // Validate status transition
      const validTransitions: Record<TripStatus, TripStatus[]> = {
        [TripStatus.REQUESTED]: [TripStatus.ACCEPTED, TripStatus.CANCELLED],
        [TripStatus.ACCEPTED]: [TripStatus.DRIVER_ARRIVED, TripStatus.CANCELLED],
        [TripStatus.DRIVER_ARRIVED]: [TripStatus.IN_PROGRESS, TripStatus.CANCELLED],
        [TripStatus.IN_PROGRESS]: [TripStatus.COMPLETED],
        [TripStatus.COMPLETED]: [],
        [TripStatus.CANCELLED]: []
      };
      
      if (!validTransitions[trip.status].includes(status)) {
        throw new Error(`Cannot change status from ${trip.status} to ${status}`);
      }
      
      // Only drivers can update to certain statuses
      const driverOnlyStatuses = [TripStatus.DRIVER_ARRIVED, TripStatus.IN_PROGRESS, TripStatus.COMPLETED];
      if (driverOnlyStatuses.includes(status) && !isDriver) {
        throw new Error('Only the assigned driver can update to this status');
      }
      
      // Update trip status
      trip.updateStatus(status);
      await trip.save();
      
      // Handle status-specific logic
      if (status === TripStatus.COMPLETED) {
        // Update driver availability
        if (trip.driverId) {
          const driver = await Driver.findById(trip.driverId);
          if (driver) {
            driver.availability = DriverAvailability.ONLINE;
            driver.stats.totalTrips += 1;
            driver.stats.totalEarnings += trip.fareBreakdown.totalFare;
            await driver.save();
          }
        }
        
        // Process payment
        this.broker.call('payment.processRidePayment', {
          tripId: trip._id,
          amount: trip.fareBreakdown.totalFare,
          paymentMethod: trip.paymentMethod
        });
      }
      
      this.logger.info(`Trip status updated: ${tripId} -> ${status}`);
      
      // Emit status update event
      this.broker.emit('ride.statusUpdated', {
        trip: trip.toJSON(),
        previousStatus: trip.status,
        newStatus: status
      });
      
      return {
        trip: trip.toJSON(),
        message: `Trip status updated to ${status}`
      };
      
    } catch (error) {
      this.logger.error('Update trip status error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to update trip status');
    }
  }
  
  /**
   * Cancel trip
   */
  public async cancelTrip(ctx: Context): Promise<{ message: string }> {
    const userId = ctx.meta.user?.userId;
    const { tripId } = ctx.params as any;
    const { reason } = ctx.params as any;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const trip = await Trip.findById(tripId).populate('driverId');
      if (!trip) {
        throw new Error('Trip not found');
      }
      
      if (!trip.canBeCancelled()) {
        throw new Error('Trip cannot be cancelled at this stage');
      }
      
      // Check permissions
      const isPassenger = trip.passengerId.toString() === userId;
      const isDriver = trip.driverId && (trip.driverId as any).userId.toString() === userId;
      
      if (!isPassenger && !isDriver) {
        throw new Error('You are not authorized to cancel this trip');
      }
      
      // Cancel the trip
      trip.updateStatus(TripStatus.CANCELLED);
      trip.cancellationReason = reason || 'Trip cancelled';
      trip.cancelledBy = isPassenger ? 'passenger' : 'driver';
      await trip.save();
      
      // Update driver availability if assigned
      if (trip.driverId) {
        const driver = await Driver.findById(trip.driverId);
        if (driver) {
          driver.availability = DriverAvailability.ONLINE;
          await driver.save();
        }
      }
      
      this.logger.info(`Trip cancelled: ${tripId} by ${trip.cancelledBy}`);
      
      // Emit trip cancelled event
      this.broker.emit('ride.cancelled', {
        trip: trip.toJSON(),
        cancelledBy: trip.cancelledBy,
        reason
      });
      
      return {
        message: 'Trip cancelled successfully'
      };
      
    } catch (error) {
      this.logger.error('Cancel trip error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to cancel trip');
    }
  }
  
  /**
   * Get trip details
   */
  public async getTrip(ctx: Context): Promise<{ trip: Partial<ITrip> }> {
    const userId = ctx.meta.user?.userId;
    const { tripId } = ctx.params as any;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const trip = await Trip.findById(tripId)
        .populate('passengerId', 'firstName lastName phone')
        .populate('driverId');
      
      if (!trip) {
        throw new Error('Trip not found');
      }
      
      // Check permissions
      const isPassenger = trip.passengerId._id.toString() === userId;
      const isDriver = trip.driverId && (trip.driverId as any).userId.toString() === userId;
      const isAdmin = ctx.meta.user?.role === UserRole.ADMIN;
      
      if (!isPassenger && !isDriver && !isAdmin) {
        throw new Error('You are not authorized to view this trip');
      }
      
      return {
        trip: trip.toJSON()
      };
      
    } catch (error) {
      this.logger.error('Get trip error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to get trip details');
    }
  }
  
  /**
   * Get user's trips
   */
  public async getMyTrips(ctx: Context): Promise<{ trips: Partial<ITrip>[]; total: number }> {
    const userId = ctx.meta.user?.userId;
    const userRole = ctx.meta.user?.role;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    const page = parseInt((ctx.params as any).page) || 1;
    const limit = parseInt((ctx.params as any).limit) || 20;
    const status = (ctx.params as any).status as TripStatus;
    
    try {
      let query: any = {};
      
      if (userRole === UserRole.PASSENGER) {
        query.passengerId = userId;
      } else if (userRole === UserRole.DRIVER) {
        const driver = await Driver.findOne({ userId });
        if (!driver) {
          throw new Error('Driver profile not found');
        }
        query.driverId = driver._id;
      } else {
        throw new Error('Invalid user role for this action');
      }
      
      if (status) {
        query.status = status;
      }
      
      const skip = (page - 1) * limit;
      
      const [trips, total] = await Promise.all([
        Trip.find(query)
          .populate('passengerId', 'firstName lastName')
          .populate('driverId')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        Trip.countDocuments(query)
      ]);
      
      return {
        trips: trips.map(trip => trip.toJSON()),
        total
      };
      
    } catch (error) {
      this.logger.error('Get my trips error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to get trips');
    }
  }
  
  /**
   * Get active trip
   */
  public async getActiveTrip(ctx: Context): Promise<{ trip: Partial<ITrip> | null }> {
    const userId = ctx.meta.user?.userId;
    const userRole = ctx.meta.user?.role;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      let query: any = {
        status: { $in: [TripStatus.REQUESTED, TripStatus.ACCEPTED, TripStatus.DRIVER_ARRIVED, TripStatus.IN_PROGRESS] }
      };
      
      if (userRole === UserRole.PASSENGER) {
        query.passengerId = userId;
      } else if (userRole === UserRole.DRIVER) {
        const driver = await Driver.findOne({ userId });
        if (!driver) {
          return { trip: null };
        }
        query.driverId = driver._id;
      } else {
        throw new Error('Invalid user role for this action');
      }
      
      const trip = await Trip.findOne(query)
        .populate('passengerId', 'firstName lastName phone')
        .populate('driverId');
      
      return {
        trip: trip ? trip.toJSON() : null
      };
      
    } catch (error) {
      this.logger.error('Get active trip error:', error);
      throw new Error('Failed to get active trip');
    }
  }
  
  /**
   * Rate trip
   */
  public async rateTrip(ctx: Context): Promise<{ message: string }> {
    const userId = ctx.meta.user?.userId;
    const userRole = ctx.meta.user?.role;
    const { tripId } = ctx.params as any;
    const { rating, comment } = RateTripSchema.parse(ctx.params);
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const trip = await Trip.findById(tripId).populate('driverId');
      if (!trip) {
        throw new Error('Trip not found');
      }
      
      if (trip.status !== TripStatus.COMPLETED) {
        throw new Error('Can only rate completed trips');
      }
      
      // Check permissions and determine rating type
      const isPassenger = trip.passengerId.toString() === userId;
      const isDriver = trip.driverId && (trip.driverId as any).userId.toString() === userId;
      
      if (!isPassenger && !isDriver) {
        throw new Error('You are not authorized to rate this trip');
      }
      
      // Initialize ratings if not exists
      if (!trip.ratings) {
        trip.ratings = {};
      }
      
      const ratingData = {
        rating,
        comment,
        ratedAt: new Date()
      };
      
      if (isPassenger) {
        if (trip.ratings.passengerRating) {
          throw new Error('You have already rated this trip');
        }
        trip.ratings.passengerRating = ratingData;
        
        // Update driver's average rating
        if (trip.driverId) {
          const driver = await Driver.findById(trip.driverId);
          if (driver) {
            const totalRatings = driver.stats.totalRatings + 1;
            const newAverage = ((driver.stats.averageRating * driver.stats.totalRatings) + rating) / totalRatings;
            driver.stats.averageRating = Math.round(newAverage * 100) / 100;
            driver.stats.totalRatings = totalRatings;
            await driver.save();
          }
        }
      } else {
        if (trip.ratings.driverRating) {
          throw new Error('You have already rated this trip');
        }
        trip.ratings.driverRating = ratingData;
      }
      
      await trip.save();
      
      this.logger.info(`Trip rated: ${tripId} by ${userRole}`);
      
      return {
        message: 'Trip rated successfully'
      };
      
    } catch (error) {
      this.logger.error('Rate trip error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to rate trip');
    }
  }
  
  /**
   * Get fare estimate
   */
  public async getFareEstimate(ctx: Context): Promise<{ fareBreakdown: any; estimatedDuration: number }> {
    const { pickupLocation, dropoffLocation, vehicleType } = ctx.params as any;
    
    if (!pickupLocation?.coordinates || !dropoffLocation?.coordinates) {
      throw new Error('Pickup and dropoff coordinates are required');
    }
    
    try {
      const distance = this.calculateDistance(
        pickupLocation.coordinates[1],
        pickupLocation.coordinates[0],
        dropoffLocation.coordinates[1],
        dropoffLocation.coordinates[0]
      );
      
      const estimatedDuration = Math.max(distance * 2, 5);
      const fareBreakdown = this.calculateFare(distance, estimatedDuration, vehicleType);
      
      return {
        fareBreakdown,
        estimatedDuration
      };
      
    } catch (error) {
      this.logger.error('Get fare estimate error:', error);
      throw new Error('Failed to calculate fare estimate');
    }
  }
  
  /**
   * List trips (admin only)
   */
  public async listTrips(ctx: Context): Promise<any> {
    this.checkAdminPermission(ctx);
    
    const page = parseInt((ctx.params as any).page) || 1;
    const limit = parseInt((ctx.params as any).limit) || 20;
    const status = (ctx.params as any).status as TripStatus;
    const startDate = (ctx.params as any).startDate;
    const endDate = (ctx.params as any).endDate;
    
    try {
      const query: any = {};
      
      if (status) {
        query.status = status;
      }
      
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
      }
      
      const skip = (page - 1) * limit;
      
      const [trips, total] = await Promise.all([
        Trip.find(query)
          .populate('passengerId', 'firstName lastName email')
          .populate('driverId')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        Trip.countDocuments(query)
      ]);
      
      return {
        trips: trips.map(trip => trip.toJSON()),
        total,
        page,
        limit
      };
      
    } catch (error) {
      this.logger.error('List trips error:', error);
      throw new Error('Failed to list trips');
    }
  }
  
  /**
   * Get trip statistics (admin only)
   */
  public async getTripStats(ctx: Context): Promise<any> {
    this.checkAdminPermission(ctx);
    
    try {
      const stats = await Trip.aggregate([
        {
          $group: {
            _id: null,
            totalTrips: { $sum: 1 },
            completedTrips: {
              $sum: { $cond: [{ $eq: ['$status', TripStatus.COMPLETED] }, 1, 0] }
            },
            cancelledTrips: {
              $sum: { $cond: [{ $eq: ['$status', TripStatus.CANCELLED] }, 1, 0] }
            },
            totalRevenue: {
              $sum: { $cond: [{ $eq: ['$status', TripStatus.COMPLETED] }, '$fareBreakdown.totalFare', 0] }
            },
            averageFare: {
              $avg: { $cond: [{ $eq: ['$status', TripStatus.COMPLETED] }, '$fareBreakdown.totalFare', null] }
            },
            averageDistance: {
              $avg: { $cond: [{ $eq: ['$status', TripStatus.COMPLETED] }, '$actualDistance', '$estimatedDistance'] }
            }
          }
        }
      ]);
      
      // Get daily stats for the last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const dailyStats = await Trip.aggregate([
        {
          $match: {
            createdAt: { $gte: thirtyDaysAgo }
          }
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
            },
            trips: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ['$status', TripStatus.COMPLETED] }, 1, 0] }
            },
            revenue: {
              $sum: { $cond: [{ $eq: ['$status', TripStatus.COMPLETED] }, '$fareBreakdown.totalFare', 0] }
            }
          }
        },
        { $sort: { _id: 1 } }
      ]);
      
      return {
        stats: stats[0] || {
          totalTrips: 0,
          completedTrips: 0,
          cancelledTrips: 0,
          totalRevenue: 0,
          averageFare: 0,
          averageDistance: 0
        },
        dailyStats
      };
      
    } catch (error) {
      this.logger.error('Get trip stats error:', error);
      throw new Error('Failed to get trip statistics');
    }
  }
  
  /**
   * Find trip by ID (internal)
   */
  public async findById(ctx: Context<{ tripId: string }>): Promise<ITrip | null> {
    const { tripId } = ctx.params;
    
    try {
      return await Trip.findById(tripId);
    } catch (error) {
      this.logger.error('Find trip by ID error:', error);
      return null;
    }
  }
  
  /**
   * Calculate distance between two points (Haversine formula)
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
  
  /**
   * Calculate fare breakdown
   */
  private calculateFare(distance: number, duration: number, vehicleType?: string): any {
    const baseFare = 2.50;
    const perKmRate = vehicleType === 'luxury' ? 2.00 : 1.20;
    const perMinuteRate = 0.25;
    const taxRate = 0.08;
    
    const distanceFare = distance * perKmRate;
    const timeFare = duration * perMinuteRate;
    const surgeMultiplier = 1; // Could be dynamic based on demand
    const subtotal = (baseFare + distanceFare + timeFare) * surgeMultiplier;
    const tax = subtotal * taxRate;
    const totalFare = subtotal + tax;
    
    return {
      baseFare,
      distanceFare,
      timeFare,
      surgeMultiplier,
      discount: 0,
      tax,
      tip: 0,
      totalFare: Math.round(totalFare * 100) / 100
    };
  }
  
  /**
   * Find nearby drivers
   */
  private async findNearbyDrivers(lat: number, lng: number, vehicleType: string): Promise<any[]> {
    try {
      const drivers = await Driver.find({
        driverStatus: DriverStatus.APPROVED,
        availability: DriverAvailability.ONLINE,
        'vehicle.type': vehicleType,
        currentLocation: {
          $near: {
            $geometry: {
              type: 'Point',
              coordinates: [lng, lat]
            },
            $maxDistance: 5000 // 5km radius
          }
        }
      }).limit(10);
      
      return drivers;
    } catch (error) {
      this.logger.error('Find nearby drivers error:', error);
      return [];
    }
  }
  
  /**
   * Notify drivers about new ride request
   */
  private async notifyDrivers(drivers: any[], trip: ITrip): Promise<void> {
    try {
      for (const driver of drivers) {
        // Emit notification to specific driver
        this.broker.emit('ride.newRequest', {
          driverId: driver._id,
          trip: trip.toJSON()
        });
        
        // Send push notification
        this.broker.call('notification.sendPushNotification', {
          userId: driver.userId,
          title: 'New Ride Request',
          message: `New ride request from ${trip.pickupLocation.address}`,
          data: { tripId: trip._id }
        });
      }
    } catch (error) {
      this.logger.error('Notify drivers error:', error);
    }
  }
  
  /**
   * Check user permission
   */
  private checkUserPermission(ctx: Context, allowedRoles: UserRole[]): void {
    const userRole = ctx.meta.user?.role;
    
    if (!allowedRoles.includes(userRole)) {
      throw new Error('Insufficient permissions');
    }
  }
  
  /**
   * Check admin permission
   */
  private checkAdminPermission(ctx: Context): void {
    const userRole = ctx.meta.user?.role;
    
    if (userRole !== UserRole.ADMIN) {
      throw new Error('Admin access required');
    }
  }
  
  /**
   * Event handler for driver location updates
   */
  private async onDriverLocationUpdated(payload: any): Promise<void> {
    this.logger.info(`Driver location updated: ${payload.driverId}`);
    
    // Here you could implement logic to notify passengers about driver location
    // during active trips
  }
  
  /**
   * Event handler for payment completion
   */
  private async onPaymentCompleted(payload: any): Promise<void> {
    const { tripId, status } = payload;
    
    try {
      const trip = await Trip.findById(tripId);
      if (trip) {
        trip.paymentStatus = status;
        await trip.save();
        
        this.logger.info(`Payment completed for trip: ${tripId}`);
      }
    } catch (error) {
      this.logger.error('Payment completion handler error:', error);
    }
  }
}
