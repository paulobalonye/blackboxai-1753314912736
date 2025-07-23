import { Service, ServiceBroker, Context } from 'moleculer';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { User, IUser, UserRole, UserStatus } from '../models/User.model';
import { Wallet } from '../models/Wallet.model';
import config from '../config';

// Validation schemas
const SignupSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  firstName: z.string().min(1, 'First name is required').max(50),
  lastName: z.string().min(1, 'Last name is required').max(50),
  phone: z.string().regex(/^\+?[\d\s-()]+$/, 'Invalid phone number format'),
  role: z.enum([UserRole.PASSENGER, UserRole.DRIVER]).optional(),
  dateOfBirth: z.string().datetime().optional(),
  address: z.object({
    street: z.string(),
    city: z.string(),
    state: z.string(),
    zipCode: z.string(),
    country: z.string().default('US')
  }).optional()
});

const LoginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required')
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters')
});

interface JWTPayload {
  userId: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

export default class AuthService extends Service {
  public constructor(broker: ServiceBroker) {
    super(broker);
    
    this.parseServiceSchema({
      name: 'auth',
      version: 1,
      
      settings: {
        JWT_SECRET: config.jwtSecret,
        JWT_EXPIRES_IN: config.jwtExpiresIn
      },
      
      actions: {
        signup: {
          rest: 'POST /signup',
          params: SignupSchema,
          handler: this.signup
        },
        
        login: {
          rest: 'POST /login',
          params: LoginSchema,
          handler: this.login
        },
        
        logout: {
          rest: 'POST /logout',
          auth: 'required',
          handler: this.logout
        },
        
        verify: {
          rest: 'GET /verify',
          auth: 'required',
          handler: this.verify
        },
        
        changePassword: {
          rest: 'PUT /change-password',
          auth: 'required',
          params: ChangePasswordSchema,
          handler: this.changePassword
        },
        
        refreshToken: {
          rest: 'POST /refresh-token',
          handler: this.refreshToken
        },
        
        // Internal action for token verification
        verifyToken: {
          visibility: 'private',
          handler: this.verifyToken
        }
      },
      
      methods: {
        generateToken: this.generateToken,
        verifyTokenInternal: this.verifyTokenInternal,
        hashPassword: this.hashPassword
      },
      
      events: {
        'user.created': this.onUserCreated
      }
    });
  }
  
  /**
   * User signup action
   */
  public async signup(ctx: Context<z.infer<typeof SignupSchema>>): Promise<{ user: Partial<IUser>; token: string }> {
    const { email, password, firstName, lastName, phone, role = UserRole.PASSENGER, dateOfBirth, address } = ctx.params;
    
    try {
      // Check if user already exists
      const existingUser = await User.findOne({
        $or: [{ email }, { phone }]
      });
      
      if (existingUser) {
        throw new Error('User with this email or phone already exists');
      }
      
      // Create new user
      const userData: Partial<IUser> = {
        email,
        password,
        firstName,
        lastName,
        phone,
        role,
        status: UserStatus.ACTIVE
      };
      
      if (dateOfBirth) {
        userData.dateOfBirth = new Date(dateOfBirth);
      }
      
      if (address) {
        userData.address = address;
      }
      
      const user = new User(userData);
      await user.save();
      
      // Create wallet for the user
      const wallet = new Wallet({
        userId: user._id,
        balance: 0,
        currency: 'USD'
      });
      await wallet.save();
      
      // Generate JWT token
      const token = this.generateToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role
      });
      
      // Emit user created event
      this.broker.emit('user.created', { user: user.toJSON(), wallet: wallet.toJSON() });
      
      this.logger.info(`New user registered: ${email} (${role})`);
      
      return {
        user: user.toJSON(),
        token
      };
      
    } catch (error) {
      this.logger.error('Signup error:', error);
      throw new Error(error instanceof Error ? error.message : 'Registration failed');
    }
  }
  
  /**
   * User login action
   */
  public async login(ctx: Context<z.infer<typeof LoginSchema>>): Promise<{ user: Partial<IUser>; token: string }> {
    const { email, password } = ctx.params;
    
    try {
      // Find user by email
      const user = await User.findOne({ email }).select('+password');
      
      if (!user) {
        throw new Error('Invalid email or password');
      }
      
      // Check if user is active
      if (user.status !== UserStatus.ACTIVE) {
        throw new Error('Account is suspended or inactive');
      }
      
      // Verify password
      const isPasswordValid = await user.comparePassword(password);
      if (!isPasswordValid) {
        throw new Error('Invalid email or password');
      }
      
      // Update last login
      user.lastLoginAt = new Date();
      await user.save();
      
      // Generate JWT token
      const token = this.generateToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role
      });
      
      this.logger.info(`User logged in: ${email}`);
      
      return {
        user: user.toJSON(),
        token
      };
      
    } catch (error) {
      this.logger.error('Login error:', error);
      throw new Error(error instanceof Error ? error.message : 'Login failed');
    }
  }
  
  /**
   * User logout action
   */
  public async logout(ctx: Context): Promise<{ message: string }> {
    // In a stateless JWT system, logout is handled client-side
    // Here we could implement token blacklisting if needed
    
    this.logger.info(`User logged out: ${ctx.meta.user?.email}`);
    
    return {
      message: 'Logged out successfully'
    };
  }
  
  /**
   * Verify current user action
   */
  public async verify(ctx: Context): Promise<{ user: Partial<IUser> }> {
    const userId = ctx.meta.user?.userId;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const user = await User.findById(userId);
      
      if (!user) {
        throw new Error('User not found');
      }
      
      if (user.status !== UserStatus.ACTIVE) {
        throw new Error('Account is suspended or inactive');
      }
      
      return {
        user: user.toJSON()
      };
      
    } catch (error) {
      this.logger.error('Verify error:', error);
      throw new Error(error instanceof Error ? error.message : 'Verification failed');
    }
  }
  
  /**
   * Change password action
   */
  public async changePassword(ctx: Context<z.infer<typeof ChangePasswordSchema>>): Promise<{ message: string }> {
    const { currentPassword, newPassword } = ctx.params;
    const userId = ctx.meta.user?.userId;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const user = await User.findById(userId).select('+password');
      
      if (!user) {
        throw new Error('User not found');
      }
      
      // Verify current password
      const isCurrentPasswordValid = await user.comparePassword(currentPassword);
      if (!isCurrentPasswordValid) {
        throw new Error('Current password is incorrect');
      }
      
      // Update password
      user.password = newPassword;
      await user.save();
      
      this.logger.info(`Password changed for user: ${user.email}`);
      
      return {
        message: 'Password changed successfully'
      };
      
    } catch (error) {
      this.logger.error('Change password error:', error);
      throw new Error(error instanceof Error ? error.message : 'Password change failed');
    }
  }
  
  /**
   * Refresh token action
   */
  public async refreshToken(ctx: Context<{ token: string }>): Promise<{ token: string }> {
    const { token } = ctx.params;
    
    try {
      const decoded = this.verifyTokenInternal(token);
      
      // Check if user still exists and is active
      const user = await User.findById(decoded.userId);
      
      if (!user || user.status !== UserStatus.ACTIVE) {
        throw new Error('Invalid token or user not found');
      }
      
      // Generate new token
      const newToken = this.generateToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role
      });
      
      return {
        token: newToken
      };
      
    } catch (error) {
      this.logger.error('Refresh token error:', error);
      throw new Error('Token refresh failed');
    }
  }
  
  /**
   * Internal token verification action
   */
  public async verifyToken(ctx: Context<{ token: string }>): Promise<JWTPayload> {
    const { token } = ctx.params;
    
    try {
      return this.verifyTokenInternal(token);
    } catch (error) {
      throw new Error('Invalid token');
    }
  }
  
  /**
   * Generate JWT token
   */
  private generateToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
    return jwt.sign(payload, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn
    });
  }
  
  /**
   * Verify JWT token internally
   */
  private verifyTokenInternal(token: string): JWTPayload {
    return jwt.verify(token, config.jwtSecret) as JWTPayload;
  }
  
  /**
   * Hash password (not used directly, handled by User model)
   */
  private async hashPassword(password: string): Promise<string> {
    const bcrypt = require('bcryptjs');
    const salt = await bcrypt.genSalt(12);
    return bcrypt.hash(password, salt);
  }
  
  /**
   * Event handler for user creation
   */
  private async onUserCreated(payload: { user: IUser; wallet: any }): Promise<void> {
    this.logger.info(`User created event received for: ${payload.user.email}`);
    
    // Here you could trigger welcome email, notifications, etc.
    // await this.broker.call('notification.sendWelcomeEmail', { user: payload.user });
  }
}
