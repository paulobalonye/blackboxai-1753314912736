import { Service, ServiceBroker, Context } from 'moleculer';
import { z } from 'zod';
import { Driver, IDriver, DriverStatus, DriverAvailability, VehicleType } from '../models/Driver.model';
import { User, UserRole } from '../models/User.model';

// Validation schemas
const RegisterDriverSchema = z.object({
  vehicle: z.object({
    make: z.string().min(1, 'Vehicle make is required'),
    model: z.string().min(1, 'Vehicle model is required'),
    year: z.number().min(2010).max(new Date().getFullYear() + 1),
    color: z.string().min(1, 'Vehicle color is required'),
    licensePlate: z.string().min(1, 'License plate is required'),
    type: z.enum([VehicleType.SEDAN, VehicleType.SUV, VehicleType.HATCHBACK, VehicleType.LUXURY, VehicleType.BIKE]),
    capacity: z.number().min(1).max(8),
    registrationNumber: z.string().min(1, 'Registration number is required'),
    insuranceNumber: z.string().min(1, 'Insurance number is required'),
    insuranceExpiry: z.string().datetime('Invalid insurance expiry date')
  }),
  documents: z.object({
    driverLicense: z.object({
      number: z.string().min(1, 'Driver license number is required'),
      expiryDate: z.string().datetime('Invalid license expiry date'),
      imageUrl: z.string().url().optional()
    }),
    vehicleRegistration: z.object({
      number: z.string().min(1, 'Vehicle registration number is required'),
      expiryDate: z.string().datetime('Invalid registration expiry date'),
      imageUrl: z.string().url().optional()
    }),
    insurance: z.object({
      policyNumber: z.string().min(1, 'Insurance policy number is required'),
      expiryDate: z.string().datetime('Invalid insurance expiry date'),
      imageUrl: z.string().url().optional()
    })
  }),
  bankAccount: z.object({
    accountNumber: z.string().min(1, 'Account number is required'),
    routingNumber: z.string().min(1, 'Routing number is required'),
    accountHolderName: z.string().min(1, 'Account holder name is required')
  }).optional()
});

const UpdateLocationSchema = z.object({
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  address: z.string().optional()
});

const UpdateAvailabilitySchema = z.object({
  availability: z.enum([DriverAvailability.ONLINE, DriverAvailability.OFFLINE, DriverAvailability.BUSY])
});

export default class DriverService extends Service {
  public constructor(broker: ServiceBroker) {
    super(broker);
    
    this.parseServiceSchema({
      name: 'driver',
      version: 1,
      
      actions: {
        // Register as driver
        register: {
          rest: 'POST /register',
          auth: 'required',
          handler: this.registerDriver
        },
        
        // Get driver profile
        profile: {
          rest: 'GET /profile',
          auth: 'required',
          handler: this.getDriverProfile
        },
        
        // Update driver profile
        updateProfile: {
          rest: 'PUT /profile',
          auth: 'required',
          handler: this.updateDriverProfile
        },
        
        // Update driver location
        updateLocation: {
          rest: 'PUT /location',
          auth: 'required',
          handler: this.updateLocation
        },
        
        // Update driver availability
        updateAvailability: {
          rest: 'PUT /availability',
          auth: 'required',
          handler: this.updateAvailability
        },
        
        // Get nearby drivers
        getNearby: {
          rest: 'GET /nearby',
          handler: this.getNearbyDrivers
        },
        
        // Admin actions
        list: {
          rest: 'GET /',
          auth: 'required',
          handler: this.listDrivers
        },
        
        approve: {
          rest: 'PUT /:driverId/approve',
          auth: 'required',
          handler: this.approveDriver
        },
        
        reject: {
          rest: 'PUT /:driverId/reject',
          auth: 'required',
          handler: this.rejectDriver
        },
        
        suspend: {
          rest: 'PUT /:driverId/suspend',
          auth: 'required',
          handler: this.suspendDriver
        },
        
        // Get driver statistics
        stats: {
          rest: 'GET /stats',
          auth: 'required',
          handler: this.getDriverStats
        },
        
        // Internal actions
        findById: {
          visibility: 'private',
          handler: this.findById
        },
        
        findByUserId: {
          visibility: 'private',
          handler: this.findByUserId
        }
      },
      
      methods: {
        checkDriverPermission: this.checkDriverPermission,
        checkAdminPermission: this.checkAdminPermission,
        sanitizeDriver: this.sanitizeDriver
      }
    });
  }
  
  /**
   * Register as driver
   */
  public async registerDriver(ctx: Context): Promise<{ driver: Partial<IDriver>; message: string }> {
    const userId = ctx.meta.user?.userId;
    const driverData = ctx.params;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      // Validate input data
      const validatedData = RegisterDriverSchema.parse(driverData);
      
      // Check if user exists and has driver role
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }
      
      if (user.role !== UserRole.DRIVER) {
        throw new Error('User must have driver role to register as driver');
      }
      
      // Check if driver already exists
      const existingDriver = await Driver.findOne({ userId });
      if (existingDriver) {
        throw new Error('Driver profile already exists');
      }
      
      // Create driver profile
      const driver = new Driver({
        userId,
        driverStatus: DriverStatus.PENDING,
        availability: DriverAvailability.OFFLINE,
        vehicle: {
          ...validatedData.vehicle,
          insuranceExpiry: new Date(validatedData.vehicle.insuranceExpiry)
        },
        documents: {
          driverLicense: {
            ...validatedData.documents.driverLicense,
            expiryDate: new Date(validatedData.documents.driverLicense.expiryDate)
          },
          vehicleRegistration: {
            ...validatedData.documents.vehicleRegistration,
            expiryDate: new Date(validatedData.documents.vehicleRegistration.expiryDate)
          },
          insurance: {
            ...validatedData.documents.insurance,
            expiryDate: new Date(validatedData.documents.insurance.expiryDate)
          },
          backgroundCheck: {
            status: 'pending'
          }
        },
        bankAccount: validatedData.bankAccount,
        stats: {
          totalTrips: 0,
          totalEarnings: 0,
          averageRating: 0,
          totalRatings: 0,
          completionRate: 0,
          cancellationRate: 0
        }
      });
      
      await driver.save();
      
      this.logger.info(`Driver registered: ${user.email}`);
      
      // Emit driver registration event
      this.broker.emit('driver.registered', { driver: driver.toJSON(), user: user.toJSON() });
      
      return {
        driver: this.sanitizeDriver(driver),
        message: 'Driver registration submitted for approval'
      };
      
    } catch (error) {
      this.logger.error('Register driver error:', error);
      throw new Error(error instanceof Error ? error.message : 'Driver registration failed');
    }
  }
  
  /**
   * Get driver profile
   */
  public async getDriverProfile(ctx: Context): Promise<{ driver: Partial<IDriver> }> {
    const userId = ctx.meta.user?.userId;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const driver = await Driver.findOne({ userId }).populate('userId', 'firstName lastName email phone');
      
      if (!driver) {
        throw new Error('Driver profile not found');
      }
      
      return {
        driver: this.sanitizeDriver(driver)
      };
      
    } catch (error) {
      this.logger.error('Get driver profile error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to get driver profile');
    }
  }
  
  /**
   * Update driver profile
   */
  public async updateDriverProfile(ctx: Context): Promise<{ driver: Partial<IDriver>; message: string }> {
    const userId = ctx.meta.user?.userId;
    const updateData = ctx.params;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const driver = await Driver.findOne({ userId });
      
      if (!driver) {
        throw new Error('Driver profile not found');
      }
      
      // Only allow updates if driver is not approved yet or for certain fields
      if (driver.driverStatus === DriverStatus.APPROVED) {
        // Only allow updating certain fields for approved drivers
        const allowedFields = ['bankAccount', 'homeLocation'];
        const updateFields = Object.keys(updateData);
        const hasDisallowedFields = updateFields.some(field => !allowedFields.includes(field));
        
        if (hasDisallowedFields) {
          throw new Error('Cannot update vehicle or document information for approved drivers');
        }
      }
      
      // Update allowed fields
      Object.keys(updateData).forEach(key => {
        if (updateData[key] !== undefined) {
          (driver as any)[key] = updateData[key];
        }
      });
      
      await driver.save();
      
      this.logger.info(`Driver profile updated: ${userId}`);
      
      return {
        driver: this.sanitizeDriver(driver),
        message: 'Driver profile updated successfully'
      };
      
    } catch (error) {
      this.logger.error('Update driver profile error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to update driver profile');
    }
  }
  
  /**
   * Update driver location
   */
  public async updateLocation(ctx: Context): Promise<{ message: string }> {
    const userId = ctx.meta.user?.userId;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const { longitude, latitude, address } = UpdateLocationSchema.parse(ctx.params);
      
      const driver = await Driver.findOne({ userId });
      
      if (!driver) {
        throw new Error('Driver profile not found');
      }
      
      if (driver.driverStatus !== DriverStatus.APPROVED) {
        throw new Error('Driver must be approved to update location');
      }
      
      driver.updateLocation(longitude, latitude, address);
      await driver.save();
      
      // Emit location update event for real-time tracking
      this.broker.emit('driver.locationUpdated', {
        driverId: driver._id,
        userId,
        location: driver.currentLocation,
        availability: driver.availability
      });
      
      return {
        message: 'Location updated successfully'
      };
      
    } catch (error) {
      this.logger.error('Update location error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to update location');
    }
  }
  
  /**
   * Update driver availability
   */
  public async updateAvailability(ctx: Context): Promise<{ message: string; availability: DriverAvailability }> {
    const userId = ctx.meta.user?.userId;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const { availability } = UpdateAvailabilitySchema.parse(ctx.params);
      
      const driver = await Driver.findOne({ userId });
      
      if (!driver) {
        throw new Error('Driver profile not found');
      }
      
      if (driver.driverStatus !== DriverStatus.APPROVED) {
        throw new Error('Driver must be approved to change availability');
      }
      
      driver.availability = availability;
      await driver.save();
      
      // Emit availability update event
      this.broker.emit('driver.availabilityUpdated', {
        driverId: driver._id,
        userId,
        availability,
        location: driver.currentLocation
      });
      
      this.logger.info(`Driver availability updated: ${userId} -> ${availability}`);
      
      return {
        message: 'Availability updated successfully',
        availability
      };
      
    } catch (error) {
      this.logger.error('Update availability error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to update availability');
    }
  }
  
  /**
   * Get nearby drivers
   */
  public async getNearbyDrivers(ctx: Context): Promise<{ drivers: Partial<IDriver>[] }> {
    const { longitude, latitude, radius = 5000 } = ctx.params as any; // radius in meters
    
    if (!longitude || !latitude) {
      throw new Error('Longitude and latitude are required');
    }
    
    try {
      const drivers = await Driver.find({
        driverStatus: DriverStatus.APPROVED,
        availability: DriverAvailability.ONLINE,
        currentLocation: {
          $near: {
            $geometry: {
              type: 'Point',
              coordinates: [parseFloat(longitude), parseFloat(latitude)]
            },
            $maxDistance: parseInt(radius)
          }
        }
      })
      .populate('userId', 'firstName lastName')
      .limit(20);
      
      return {
        drivers: drivers.map(driver => ({
          _id: driver._id,
          userId: driver.userId,
          vehicle: driver.vehicle,
          currentLocation: driver.currentLocation,
          stats: driver.stats,
          availability: driver.availability
        }))
      };
      
    } catch (error) {
      this.logger.error('Get nearby drivers error:', error);
      throw new Error('Failed to get nearby drivers');
    }
  }
  
  /**
   * List drivers (admin only)
   */
  public async listDrivers(ctx: Context): Promise<any> {
    this.checkAdminPermission(ctx);
    
    const page = parseInt((ctx.params as any).page) || 1;
    const limit = parseInt((ctx.params as any).limit) || 20;
    const status = (ctx.params as any).status as DriverStatus;
    const search = (ctx.params as any).search as string;
    
    try {
      const query: any = {};
      
      if (status) {
        query.driverStatus = status;
      }
      
      const skip = (page - 1) * limit;
      
      let drivers;
      let total;
      
      if (search) {
        // Search in populated user fields
        const pipeline = [
          {
            $lookup: {
              from: 'users',
              localField: 'userId',
              foreignField: '_id',
              as: 'user'
            }
          },
          {
            $match: {
              ...query,
              $or: [
                { 'user.firstName': { $regex: search, $options: 'i' } },
                { 'user.lastName': { $regex: search, $options: 'i' } },
                { 'user.email': { $regex: search, $options: 'i' } },
                { 'vehicle.licensePlate': { $regex: search, $options: 'i' } }
              ]
            }
          },
          { $skip: skip },
          { $limit: limit },
          { $sort: { createdAt: -1 } }
        ];
        
        drivers = await Driver.aggregate(pipeline);
        total = await Driver.aggregate([...pipeline.slice(0, -3), { $count: 'total' }]);
        total = total[0]?.total || 0;
      } else {
        [drivers, total] = await Promise.all([
          Driver.find(query)
            .populate('userId', 'firstName lastName email phone')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
          Driver.countDocuments(query)
        ]);
      }
      
      return {
        drivers: drivers.map((driver: any) => this.sanitizeDriver(driver)),
        total,
        page,
        limit
      };
      
    } catch (error) {
      this.logger.error('List drivers error:', error);
      throw new Error('Failed to list drivers');
    }
  }
  
  /**
   * Approve driver (admin only)
   */
  public async approveDriver(ctx: Context): Promise<{ driver: Partial<IDriver>; message: string }> {
    this.checkAdminPermission(ctx);
    
    const { driverId } = ctx.params as any;
    const adminUserId = ctx.meta.user?.userId;
    
    try {
      const driver = await Driver.findById(driverId).populate('userId');
      
      if (!driver) {
        throw new Error('Driver not found');
      }
      
      if (driver.driverStatus !== DriverStatus.PENDING) {
        throw new Error('Driver is not in pending status');
      }
      
      driver.driverStatus = DriverStatus.APPROVED;
      driver.approvedAt = new Date();
      driver.approvedBy = adminUserId;
      await driver.save();
      
      // Emit driver approved event
      this.broker.emit('driver.approved', { driver: driver.toJSON() });
      
      this.logger.info(`Driver approved: ${driverId} by ${adminUserId}`);
      
      return {
        driver: this.sanitizeDriver(driver),
        message: 'Driver approved successfully'
      };
      
    } catch (error) {
      this.logger.error('Approve driver error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to approve driver');
    }
  }
  
  /**
   * Reject driver (admin only)
   */
  public async rejectDriver(ctx: Context): Promise<{ message: string }> {
    this.checkAdminPermission(ctx);
    
    const { driverId } = ctx.params as any;
    const { reason } = ctx.params as any;
    
    try {
      const driver = await Driver.findById(driverId);
      
      if (!driver) {
        throw new Error('Driver not found');
      }
      
      if (driver.driverStatus !== DriverStatus.PENDING) {
        throw new Error('Driver is not in pending status');
      }
      
      driver.driverStatus = DriverStatus.REJECTED;
      driver.rejectedAt = new Date();
      driver.rejectionReason = reason || 'Application rejected';
      await driver.save();
      
      // Emit driver rejected event
      this.broker.emit('driver.rejected', { driver: driver.toJSON(), reason });
      
      this.logger.info(`Driver rejected: ${driverId}`);
      
      return {
        message: 'Driver rejected successfully'
      };
      
    } catch (error) {
      this.logger.error('Reject driver error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to reject driver');
    }
  }
  
  /**
   * Suspend driver (admin only)
   */
  public async suspendDriver(ctx: Context): Promise<{ message: string }> {
    this.checkAdminPermission(ctx);
    
    const { driverId } = ctx.params as any;
    const { reason } = ctx.params as any;
    
    try {
      const driver = await Driver.findById(driverId);
      
      if (!driver) {
        throw new Error('Driver not found');
      }
      
      driver.driverStatus = DriverStatus.SUSPENDED;
      driver.availability = DriverAvailability.OFFLINE;
      driver.rejectionReason = reason || 'Driver suspended';
      await driver.save();
      
      // Emit driver suspended event
      this.broker.emit('driver.suspended', { driver: driver.toJSON(), reason });
      
      this.logger.info(`Driver suspended: ${driverId}`);
      
      return {
        message: 'Driver suspended successfully'
      };
      
    } catch (error) {
      this.logger.error('Suspend driver error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to suspend driver');
    }
  }
  
  /**
   * Get driver statistics (admin only)
   */
  public async getDriverStats(ctx: Context): Promise<any> {
    this.checkAdminPermission(ctx);
    
    try {
      const stats = await Driver.aggregate([
        {
          $group: {
            _id: null,
            totalDrivers: { $sum: 1 },
            pendingDrivers: {
              $sum: { $cond: [{ $eq: ['$driverStatus', DriverStatus.PENDING] }, 1, 0] }
            },
            approvedDrivers: {
              $sum: { $cond: [{ $eq: ['$driverStatus', DriverStatus.APPROVED] }, 1, 0] }
            },
            onlineDrivers: {
              $sum: { $cond: [{ $eq: ['$availability', DriverAvailability.ONLINE] }, 1, 0] }
            },
            rejectedDrivers: {
              $sum: { $cond: [{ $eq: ['$driverStatus', DriverStatus.REJECTED] }, 1, 0] }
            },
            suspendedDrivers: {
              $sum: { $cond: [{ $eq: ['$driverStatus', DriverStatus.SUSPENDED] }, 1, 0] }
            }
          }
        }
      ]);
      
      return {
        stats: stats[0] || {
          totalDrivers: 0,
          pendingDrivers: 0,
          approvedDrivers: 0,
          onlineDrivers: 0,
          rejectedDrivers: 0,
          suspendedDrivers: 0
        }
      };
      
    } catch (error) {
      this.logger.error('Get driver stats error:', error);
      throw new Error('Failed to get driver statistics');
    }
  }
  
  /**
   * Find driver by ID (internal)
   */
  public async findById(ctx: Context<{ driverId: string }>): Promise<IDriver | null> {
    const { driverId } = ctx.params;
    
    try {
      return await Driver.findById(driverId);
    } catch (error) {
      this.logger.error('Find driver by ID error:', error);
      return null;
    }
  }
  
  /**
   * Find driver by user ID (internal)
   */
  public async findByUserId(ctx: Context<{ userId: string }>): Promise<IDriver | null> {
    const { userId } = ctx.params;
    
    try {
      return await Driver.findOne({ userId });
    } catch (error) {
      this.logger.error('Find driver by user ID error:', error);
      return null;
    }
  }
  
  /**
   * Check driver permission
   */
  private checkDriverPermission(ctx: Context): void {
    const userRole = ctx.meta.user?.role;
    
    if (userRole !== UserRole.DRIVER) {
      throw new Error('Driver access required');
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
   * Sanitize driver data
   */
  private sanitizeDriver(driver: IDriver): Partial<IDriver> {
    const driverObj = driver.toJSON ? driver.toJSON() : driver;
    
    // Remove sensitive information
    if (driverObj.bankAccount) {
      driverObj.bankAccount = {
        ...driverObj.bankAccount,
        accountNumber: driverObj.bankAccount.accountNumber?.replace(/\d(?=\d{4})/g, '*'),
        routingNumber: driverObj.bankAccount.routingNumber?.replace(/\d(?=\d{4})/g, '*')
      };
    }
    
    return driverObj;
  }
}
