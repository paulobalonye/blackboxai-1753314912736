import { Service, ServiceBroker, Context } from 'moleculer';
import { z } from 'zod';
import { User, IUser, UserRole, UserStatus } from '../models/User.model';
import { Wallet } from '../models/Wallet.model';

// Validation schemas
const UpdateUserSchema = z.object({
  firstName: z.string().min(1).max(50).optional(),
  lastName: z.string().min(1).max(50).optional(),
  phone: z.string().regex(/^\+?[\d\s-()]+$/).optional(),
  dateOfBirth: z.string().datetime().optional(),
  address: z.object({
    street: z.string(),
    city: z.string(),
    state: z.string(),
    zipCode: z.string(),
    country: z.string()
  }).optional(),
  emergencyContact: z.object({
    name: z.string(),
    phone: z.string(),
    relationship: z.string()
  }).optional()
});

const GetUserSchema = z.object({
  userId: z.string().min(1, 'User ID is required')
});

export default class UserService extends Service {
  public constructor(broker: ServiceBroker) {
    super(broker);
    
    this.parseServiceSchema({
      name: 'user',
      version: 1,
      
      actions: {
        // Get current user profile
        profile: {
          rest: 'GET /profile',
          auth: 'required',
          handler: this.getProfile
        },
        
        // Update current user profile
        updateProfile: {
          rest: 'PUT /profile',
          auth: 'required',
          handler: this.updateProfile
        },
        
        // Get user by ID (admin only)
        get: {
          rest: 'GET /:userId',
          auth: 'required',
          handler: this.getUser
        },
        
        // List all users (admin only)
        list: {
          rest: 'GET /',
          auth: 'required',
          handler: this.listUsers
        },
        
        // Update user status (admin only)
        updateStatus: {
          rest: 'PUT /:userId/status',
          auth: 'required',
          handler: this.updateUserStatus
        },
        
        // Delete user (admin only)
        delete: {
          rest: 'DELETE /:userId',
          auth: 'required',
          handler: this.deleteUser
        },
        
        // Get user statistics
        stats: {
          rest: 'GET /stats',
          auth: 'required',
          handler: this.getUserStats
        },
        
        // Internal actions
        findById: {
          visibility: 'private',
          handler: this.findById
        },
        
        findByEmail: {
          visibility: 'private',
          handler: this.findByEmail
        }
      },
      
      methods: {
        checkAdminPermission: this.checkAdminPermission,
        sanitizeUser: this.sanitizeUser
      }
    });
  }
  
  /**
   * Get current user profile
   */
  public async getProfile(ctx: Context): Promise<{ user: Partial<IUser>; wallet?: any }> {
    const userId = ctx.meta.user?.userId;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const user = await User.findById(userId);
      
      if (!user) {
        throw new Error('User not found');
      }
      
      // Get user's wallet
      const wallet = await Wallet.findOne({ userId });
      
      return {
        user: this.sanitizeUser(user),
        wallet: wallet ? {
          balance: wallet.balance,
          currency: wallet.currency,
          isActive: wallet.isActive
        } : null
      };
      
    } catch (error) {
      this.logger.error('Get profile error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to get profile');
    }
  }
  
  /**
   * Update current user profile
   */
  public async updateProfile(ctx: Context): Promise<{ user: Partial<IUser>; message: string }> {
    const userId = ctx.meta.user?.userId;
    const updateData = ctx.params;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      // Validate update data
      const validatedData = UpdateUserSchema.parse(updateData);
      
      const user = await User.findById(userId);
      
      if (!user) {
        throw new Error('User not found');
      }
      
      // Update user fields
      Object.keys(validatedData).forEach(key => {
        if (validatedData[key as keyof typeof validatedData] !== undefined) {
          if (key === 'dateOfBirth' && validatedData.dateOfBirth) {
            user.dateOfBirth = new Date(validatedData.dateOfBirth);
          } else {
            (user as any)[key] = validatedData[key as keyof typeof validatedData];
          }
        }
      });
      
      await user.save();
      
      this.logger.info(`User profile updated: ${user.email}`);
      
      return {
        user: this.sanitizeUser(user),
        message: 'Profile updated successfully'
      };
      
    } catch (error) {
      this.logger.error('Update profile error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to update profile');
    }
  }
  
  /**
   * Get user by ID (admin only)
   */
  public async getUser(ctx: Context): Promise<{ user: Partial<IUser> }> {
    this.checkAdminPermission(ctx);
    
    const { userId } = ctx.params;
    
    try {
      const user = await User.findById(userId);
      
      if (!user) {
        throw new Error('User not found');
      }
      
      return {
        user: this.sanitizeUser(user)
      };
      
    } catch (error) {
      this.logger.error('Get user error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to get user');
    }
  }
  
  /**
   * List all users (admin only)
   */
  public async listUsers(ctx: Context): Promise<{ users: Partial<IUser>[]; total: number; page: number; limit: number }> {
    this.checkAdminPermission(ctx);
    
    const page = parseInt(ctx.params.page as string) || 1;
    const limit = parseInt(ctx.params.limit as string) || 20;
    const role = ctx.params.role as UserRole;
    const status = ctx.params.status as UserStatus;
    const search = ctx.params.search as string;
    
    try {
      // Build query
      const query: any = {};
      
      if (role) {
        query.role = role;
      }
      
      if (status) {
        query.status = status;
      }
      
      if (search) {
        query.$or = [
          { firstName: { $regex: search, $options: 'i' } },
          { lastName: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { phone: { $regex: search, $options: 'i' } }
        ];
      }
      
      const skip = (page - 1) * limit;
      
      const [users, total] = await Promise.all([
        User.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        User.countDocuments(query)
      ]);
      
      return {
        users: users.map(user => this.sanitizeUser(user)),
        total,
        page,
        limit
      };
      
    } catch (error) {
      this.logger.error('List users error:', error);
      throw new Error('Failed to list users');
    }
  }
  
  /**
   * Update user status (admin only)
   */
  public async updateUserStatus(ctx: Context): Promise<{ user: Partial<IUser>; message: string }> {
    this.checkAdminPermission(ctx);
    
    const { userId } = ctx.params;
    const { status } = ctx.params;
    
    if (!Object.values(UserStatus).includes(status)) {
      throw new Error('Invalid status');
    }
    
    try {
      const user = await User.findById(userId);
      
      if (!user) {
        throw new Error('User not found');
      }
      
      user.status = status;
      await user.save();
      
      this.logger.info(`User status updated: ${user.email} -> ${status}`);
      
      return {
        user: this.sanitizeUser(user),
        message: 'User status updated successfully'
      };
      
    } catch (error) {
      this.logger.error('Update user status error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to update user status');
    }
  }
  
  /**
   * Delete user (admin only)
   */
  public async deleteUser(ctx: Context): Promise<{ message: string }> {
    this.checkAdminPermission(ctx);
    
    const { userId } = ctx.params;
    
    try {
      const user = await User.findById(userId);
      
      if (!user) {
        throw new Error('User not found');
      }
      
      // Delete associated wallet
      await Wallet.deleteOne({ userId });
      
      // Delete user
      await User.findByIdAndDelete(userId);
      
      this.logger.info(`User deleted: ${user.email}`);
      
      return {
        message: 'User deleted successfully'
      };
      
    } catch (error) {
      this.logger.error('Delete user error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to delete user');
    }
  }
  
  /**
   * Get user statistics
   */
  public async getUserStats(ctx: Context): Promise<any> {
    this.checkAdminPermission(ctx);
    
    try {
      const stats = await User.aggregate([
        {
          $group: {
            _id: null,
            totalUsers: { $sum: 1 },
            activeUsers: {
              $sum: { $cond: [{ $eq: ['$status', UserStatus.ACTIVE] }, 1, 0] }
            },
            passengers: {
              $sum: { $cond: [{ $eq: ['$role', UserRole.PASSENGER] }, 1, 0] }
            },
            drivers: {
              $sum: { $cond: [{ $eq: ['$role', UserRole.DRIVER] }, 1, 0] }
            },
            admins: {
              $sum: { $cond: [{ $eq: ['$role', UserRole.ADMIN] }, 1, 0] }
            }
          }
        }
      ]);
      
      const recentUsers = await User.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .select('firstName lastName email role createdAt');
      
      return {
        stats: stats[0] || {
          totalUsers: 0,
          activeUsers: 0,
          passengers: 0,
          drivers: 0,
          admins: 0
        },
        recentUsers: recentUsers.map(user => this.sanitizeUser(user))
      };
      
    } catch (error) {
      this.logger.error('Get user stats error:', error);
      throw new Error('Failed to get user statistics');
    }
  }
  
  /**
   * Find user by ID (internal)
   */
  public async findById(ctx: Context<{ userId: string }>): Promise<IUser | null> {
    const { userId } = ctx.params;
    
    try {
      return await User.findById(userId);
    } catch (error) {
      this.logger.error('Find user by ID error:', error);
      return null;
    }
  }
  
  /**
   * Find user by email (internal)
   */
  public async findByEmail(ctx: Context<{ email: string }>): Promise<IUser | null> {
    const { email } = ctx.params;
    
    try {
      return await User.findOne({ email });
    } catch (error) {
      this.logger.error('Find user by email error:', error);
      return null;
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
   * Sanitize user data (remove sensitive information)
   */
  private sanitizeUser(user: IUser): Partial<IUser> {
    const userObj = user.toJSON();
    delete userObj.password;
    return userObj;
  }
}
