import { Service, ServiceBroker, Context } from 'moleculer';
import { z } from 'zod';
import { Wallet, IWallet, TransactionType, TransactionCategory, TransactionStatus } from '../models/Wallet.model';
import { User, UserRole } from '../models/User.model';
import config from '../config';

// Validation schemas
const TopupWalletSchema = z.object({
  amount: z.number().min(1, 'Amount must be greater than 0').max(1000, 'Maximum topup amount is $1000'),
  paymentMethod: z.string().min(1, 'Payment method is required'),
  paymentToken: z.string().optional()
});

const WithdrawSchema = z.object({
  amount: z.number().min(10, 'Minimum withdrawal amount is $10'),
  bankAccount: z.object({
    accountNumber: z.string().min(1, 'Account number is required'),
    routingNumber: z.string().min(1, 'Routing number is required'),
    accountHolderName: z.string().min(1, 'Account holder name is required')
  })
});

const TransferSchema = z.object({
  recipientId: z.string().min(1, 'Recipient ID is required'),
  amount: z.number().min(1, 'Amount must be greater than 0'),
  description: z.string().max(255).optional()
});

export default class PaymentService extends Service {
  public constructor(broker: ServiceBroker) {
    super(broker);
    
    this.parseServiceSchema({
      name: 'payment',
      version: 1,
      
      settings: {
        stripe: config.stripe
      },
      
      actions: {
        // Get wallet balance
        getWallet: {
          rest: 'GET /wallet',
          auth: 'required',
          handler: this.getWallet
        },
        
        // Topup wallet
        topup: {
          rest: 'POST /wallet/topup',
          auth: 'required',
          handler: this.topupWallet
        },
        
        // Withdraw from wallet
        withdraw: {
          rest: 'POST /wallet/withdraw',
          auth: 'required',
          handler: this.withdrawFromWallet
        },
        
        // Transfer money between wallets
        transfer: {
          rest: 'POST /wallet/transfer',
          auth: 'required',
          handler: this.transferMoney
        },
        
        // Get transaction history
        transactions: {
          rest: 'GET /wallet/transactions',
          auth: 'required',
          handler: this.getTransactionHistory
        },
        
        // Process ride payment (internal)
        processRidePayment: {
          visibility: 'private',
          handler: this.processRidePayment
        },
        
        // Refund payment (internal)
        refundPayment: {
          visibility: 'private',
          handler: this.refundPayment
        },
        
        // Admin actions
        listWallets: {
          rest: 'GET /wallets',
          auth: 'required',
          handler: this.listWallets
        },
        
        updateWalletStatus: {
          rest: 'PUT /wallets/:walletId/status',
          auth: 'required',
          handler: this.updateWalletStatus
        },
        
        getPaymentStats: {
          rest: 'GET /stats',
          auth: 'required',
          handler: this.getPaymentStats
        }
      },
      
      methods: {
        processStripePayment: this.processStripePayment,
        processStripeRefund: this.processStripeRefund,
        checkAdminPermission: this.checkAdminPermission,
        createWalletForUser: this.createWalletForUser
      },
      
      events: {
        'user.created': this.onUserCreated,
        'trip.completed': this.onTripCompleted,
        'trip.cancelled': this.onTripCancelled
      }
    });
  }
  
  /**
   * Get wallet information
   */
  public async getWallet(ctx: Context): Promise<{ wallet: Partial<IWallet> }> {
    const userId = ctx.meta.user?.userId;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      let wallet = await Wallet.findOne({ userId });
      
      if (!wallet) {
        // Create wallet if it doesn't exist
        wallet = await this.createWalletForUser(userId);
      }
      
      // Reset spending limits if needed
      wallet.resetLimits();
      await wallet.save();
      
      return {
        wallet: {
          _id: wallet._id,
          balance: wallet.balance,
          currency: wallet.currency,
          isActive: wallet.isActive,
          dailyLimit: wallet.dailyLimit,
          monthlyLimit: wallet.monthlyLimit,
          dailySpent: wallet.dailySpent,
          monthlySpent: wallet.monthlySpent
        }
      };
      
    } catch (error) {
      this.logger.error('Get wallet error:', error);
      throw new Error('Failed to get wallet information');
    }
  }
  
  /**
   * Topup wallet
   */
  public async topupWallet(ctx: Context): Promise<{ wallet: Partial<IWallet>; transaction: any; message: string }> {
    const userId = ctx.meta.user?.userId;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const { amount, paymentMethod, paymentToken } = TopupWalletSchema.parse(ctx.params);
      
      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        throw new Error('Wallet not found');
      }
      
      if (!wallet.isActive) {
        throw new Error('Wallet is not active');
      }
      
      let paymentResult;
      
      // Process payment based on method
      if (paymentMethod === 'stripe' && paymentToken) {
        paymentResult = await this.processStripePayment(amount, paymentToken);
      } else {
        throw new Error('Invalid payment method');
      }
      
      if (!paymentResult.success) {
        throw new Error(paymentResult.error || 'Payment processing failed');
      }
      
      // Add transaction to wallet
      await wallet.addTransaction({
        type: TransactionType.CREDIT,
        amount,
        category: TransactionCategory.WALLET_TOPUP,
        description: `Wallet topup via ${paymentMethod}`,
        paymentMethod,
        paymentGatewayResponse: paymentResult.data,
        status: TransactionStatus.COMPLETED
      });
      
      this.logger.info(`Wallet topped up: ${userId} - $${amount}`);
      
      // Emit wallet topup event
      this.broker.emit('wallet.topup', {
        userId,
        amount,
        newBalance: wallet.balance,
        transactionId: paymentResult.transactionId
      });
      
      return {
        wallet: {
          balance: wallet.balance,
          currency: wallet.currency
        },
        transaction: {
          amount,
          type: TransactionType.CREDIT,
          status: TransactionStatus.COMPLETED
        },
        message: 'Wallet topped up successfully'
      };
      
    } catch (error) {
      this.logger.error('Topup wallet error:', error);
      throw new Error(error instanceof Error ? error.message : 'Wallet topup failed');
    }
  }
  
  /**
   * Withdraw from wallet
   */
  public async withdrawFromWallet(ctx: Context): Promise<{ message: string; transaction: any }> {
    const userId = ctx.meta.user?.userId;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const { amount, bankAccount } = WithdrawSchema.parse(ctx.params);
      
      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        throw new Error('Wallet not found');
      }
      
      if (!wallet.isActive) {
        throw new Error('Wallet is not active');
      }
      
      if (wallet.balance < amount) {
        throw new Error('Insufficient balance');
      }
      
      // Process withdrawal (in real implementation, this would integrate with banking APIs)
      const withdrawalResult = {
        success: true,
        transactionId: `wd_${Date.now()}`,
        processingTime: '1-3 business days'
      };
      
      if (!withdrawalResult.success) {
        throw new Error('Withdrawal processing failed');
      }
      
      // Add transaction to wallet
      await wallet.addTransaction({
        type: TransactionType.DEBIT,
        amount,
        category: TransactionCategory.WITHDRAWAL,
        description: `Withdrawal to bank account ending in ${bankAccount.accountNumber.slice(-4)}`,
        paymentGatewayResponse: withdrawalResult,
        status: TransactionStatus.PROCESSING
      });
      
      this.logger.info(`Withdrawal initiated: ${userId} - $${amount}`);
      
      // Emit withdrawal event
      this.broker.emit('wallet.withdrawal', {
        userId,
        amount,
        newBalance: wallet.balance,
        transactionId: withdrawalResult.transactionId
      });
      
      return {
        message: 'Withdrawal initiated successfully',
        transaction: {
          amount,
          type: TransactionType.DEBIT,
          status: TransactionStatus.PROCESSING,
          processingTime: withdrawalResult.processingTime
        }
      };
      
    } catch (error) {
      this.logger.error('Withdraw from wallet error:', error);
      throw new Error(error instanceof Error ? error.message : 'Withdrawal failed');
    }
  }
  
  /**
   * Transfer money between wallets
   */
  public async transferMoney(ctx: Context): Promise<{ message: string }> {
    const userId = ctx.meta.user?.userId;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    try {
      const { recipientId, amount, description } = TransferSchema.parse(ctx.params);
      
      if (recipientId === userId) {
        throw new Error('Cannot transfer to yourself');
      }
      
      // Get sender wallet
      const senderWallet = await Wallet.findOne({ userId });
      if (!senderWallet) {
        throw new Error('Sender wallet not found');
      }
      
      // Get recipient wallet
      const recipientWallet = await Wallet.findOne({ userId: recipientId });
      if (!recipientWallet) {
        throw new Error('Recipient wallet not found');
      }
      
      if (!senderWallet.isActive || !recipientWallet.isActive) {
        throw new Error('One or both wallets are not active');
      }
      
      if (!senderWallet.canSpend(amount)) {
        throw new Error('Transfer exceeds spending limits');
      }
      
      const transferId = `tf_${Date.now()}`;
      
      // Debit from sender
      await senderWallet.debit(
        amount,
        TransactionCategory.WALLET_TOPUP,
        description || `Transfer to user ${recipientId}`,
        transferId
      );
      
      // Credit to recipient
      await recipientWallet.credit(
        amount,
        TransactionCategory.WALLET_TOPUP,
        description || `Transfer from user ${userId}`,
        transferId
      );
      
      this.logger.info(`Money transferred: ${userId} -> ${recipientId} - $${amount}`);
      
      // Emit transfer events
      this.broker.emit('wallet.transfer', {
        senderId: userId,
        recipientId,
        amount,
        transferId
      });
      
      return {
        message: 'Money transferred successfully'
      };
      
    } catch (error) {
      this.logger.error('Transfer money error:', error);
      throw new Error(error instanceof Error ? error.message : 'Transfer failed');
    }
  }
  
  /**
   * Get transaction history
   */
  public async getTransactionHistory(ctx: Context): Promise<{ transactions: any[]; total: number }> {
    const userId = ctx.meta.user?.userId;
    
    if (!userId) {
      throw new Error('User not authenticated');
    }
    
    const page = parseInt((ctx.params as any).page) || 1;
    const limit = parseInt((ctx.params as any).limit) || 20;
    const category = (ctx.params as any).category as TransactionCategory;
    
    try {
      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        throw new Error('Wallet not found');
      }
      
      let transactions = wallet.transactions;
      
      // Filter by category if specified
      if (category) {
        transactions = transactions.filter(t => t.category === category);
      }
      
      // Sort by date (newest first)
      transactions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      
      const total = transactions.length;
      const skip = (page - 1) * limit;
      const paginatedTransactions = transactions.slice(skip, skip + limit);
      
      return {
        transactions: paginatedTransactions,
        total
      };
      
    } catch (error) {
      this.logger.error('Get transaction history error:', error);
      throw new Error('Failed to get transaction history');
    }
  }
  
  /**
   * Process ride payment (internal)
   */
  public async processRidePayment(ctx: Context<{ tripId: string; amount: number; paymentMethod: string }>): Promise<{ success: boolean; transactionId?: string }> {
    const { tripId, amount, paymentMethod } = ctx.params;
    
    try {
      // Get trip details to find passenger and driver
      const trip = await this.broker.call('ride.findById', { tripId });
      if (!trip) {
        throw new Error('Trip not found');
      }
      
      const passengerWallet = await Wallet.findOne({ userId: trip.passengerId });
      if (!passengerWallet) {
        throw new Error('Passenger wallet not found');
      }
      
      let success = false;
      let transactionId = '';
      
      if (paymentMethod === 'wallet') {
        // Debit from passenger wallet
        await passengerWallet.debit(
          amount,
          TransactionCategory.RIDE_PAYMENT,
          `Payment for trip ${tripId}`,
          tripId
        );
        
        // Credit to driver wallet (minus platform fee)
        if (trip.driverId) {
          const driverWallet = await Wallet.findOne({ userId: trip.driverId.userId });
          if (driverWallet) {
            const platformFee = amount * 0.15; // 15% platform fee
            const driverEarning = amount - platformFee;
            
            await driverWallet.credit(
              driverEarning,
              TransactionCategory.RIDE_EARNING,
              `Earning from trip ${tripId}`,
              tripId
            );
          }
        }
        
        success = true;
        transactionId = tripId;
      }
      
      // Emit payment completed event
      this.broker.emit('payment.completed', {
        tripId,
        amount,
        paymentMethod,
        success,
        transactionId
      });
      
      return { success, transactionId };
      
    } catch (error) {
      this.logger.error('Process ride payment error:', error);
      return { success: false };
    }
  }
  
  /**
   * Refund payment (internal)
   */
  public async refundPayment(ctx: Context<{ tripId: string; amount: number; reason: string }>): Promise<{ success: boolean }> {
    const { tripId, amount, reason } = ctx.params;
    
    try {
      // Get trip details
      const trip = await this.broker.call('ride.findById', { tripId });
      if (!trip) {
        throw new Error('Trip not found');
      }
      
      const passengerWallet = await Wallet.findOne({ userId: trip.passengerId });
      if (!passengerWallet) {
        throw new Error('Passenger wallet not found');
      }
      
      // Credit refund to passenger wallet
      await passengerWallet.credit(
        amount,
        TransactionCategory.REFUND,
        `Refund for trip ${tripId}: ${reason}`,
        tripId
      );
      
      this.logger.info(`Refund processed: ${tripId} - $${amount}`);
      
      return { success: true };
      
    } catch (error) {
      this.logger.error('Refund payment error:', error);
      return { success: false };
    }
  }
  
  /**
   * List wallets (admin only)
   */
  public async listWallets(ctx: Context): Promise<any> {
    this.checkAdminPermission(ctx);
    
    const page = parseInt((ctx.params as any).page) || 1;
    const limit = parseInt((ctx.params as any).limit) || 20;
    const isActive = (ctx.params as any).isActive;
    
    try {
      const query: any = {};
      
      if (isActive !== undefined) {
        query.isActive = isActive === 'true';
      }
      
      const skip = (page - 1) * limit;
      
      const [wallets, total] = await Promise.all([
        Wallet.find(query)
          .populate('userId', 'firstName lastName email')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        Wallet.countDocuments(query)
      ]);
      
      return {
        wallets: wallets.map(wallet => ({
          _id: wallet._id,
          userId: wallet.userId,
          balance: wallet.balance,
          currency: wallet.currency,
          isActive: wallet.isActive,
          createdAt: wallet.createdAt
        })),
        total,
        page,
        limit
      };
      
    } catch (error) {
      this.logger.error('List wallets error:', error);
      throw new Error('Failed to list wallets');
    }
  }
  
  /**
   * Update wallet status (admin only)
   */
  public async updateWalletStatus(ctx: Context): Promise<{ message: string }> {
    this.checkAdminPermission(ctx);
    
    const { walletId } = ctx.params as any;
    const { isActive } = ctx.params as any;
    
    try {
      const wallet = await Wallet.findById(walletId);
      if (!wallet) {
        throw new Error('Wallet not found');
      }
      
      wallet.isActive = isActive;
      await wallet.save();
      
      this.logger.info(`Wallet status updated: ${walletId} -> ${isActive ? 'active' : 'inactive'}`);
      
      return {
        message: 'Wallet status updated successfully'
      };
      
    } catch (error) {
      this.logger.error('Update wallet status error:', error);
      throw new Error('Failed to update wallet status');
    }
  }
  
  /**
   * Get payment statistics (admin only)
   */
  public async getPaymentStats(ctx: Context): Promise<any> {
    this.checkAdminPermission(ctx);
    
    try {
      const stats = await Wallet.aggregate([
        {
          $group: {
            _id: null,
            totalWallets: { $sum: 1 },
            activeWallets: {
              $sum: { $cond: ['$isActive', 1, 0] }
            },
            totalBalance: { $sum: '$balance' },
            averageBalance: { $avg: '$balance' }
          }
        }
      ]);
      
      // Get transaction stats
      const transactionStats = await Wallet.aggregate([
        { $unwind: '$transactions' },
        {
          $group: {
            _id: '$transactions.category',
            count: { $sum: 1 },
            totalAmount: { $sum: '$transactions.amount' }
          }
        }
      ]);
      
      return {
        walletStats: stats[0] || {
          totalWallets: 0,
          activeWallets: 0,
          totalBalance: 0,
          averageBalance: 0
        },
        transactionStats
      };
      
    } catch (error) {
      this.logger.error('Get payment stats error:', error);
      throw new Error('Failed to get payment statistics');
    }
  }
  
  /**
   * Process Stripe payment
   */
  private async processStripePayment(amount: number, paymentToken: string): Promise<any> {
    try {
      // Mock Stripe payment processing
      // In real implementation, use Stripe SDK
      const mockResult = {
        success: true,
        transactionId: `pi_${Date.now()}`,
        data: {
          id: `pi_${Date.now()}`,
          amount: amount * 100, // Stripe uses cents
          currency: 'usd',
          status: 'succeeded'
        }
      };
      
      return mockResult;
    } catch (error) {
      return {
        success: false,
        error: 'Payment processing failed'
      };
    }
  }
  
  /**
   * Process Stripe refund
   */
  private async processStripeRefund(paymentIntentId: string, amount: number): Promise<any> {
    try {
      // Mock Stripe refund processing
      const mockResult = {
        success: true,
        refundId: `re_${Date.now()}`,
        amount: amount * 100
      };
      
      return mockResult;
    } catch (error) {
      return {
        success: false,
        error: 'Refund processing failed'
      };
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
   * Create wallet for user
   */
  private async createWalletForUser(userId: string): Promise<IWallet> {
    const wallet = new Wallet({
      userId,
      balance: 0,
      currency: 'USD',
      isActive: true
    });
    
    await wallet.save();
    return wallet;
  }
  
  /**
   * Event handler for user creation
   */
  private async onUserCreated(payload: { user: any }): Promise<void> {
    try {
      await this.createWalletForUser(payload.user._id);
      this.logger.info(`Wallet created for new user: ${payload.user.email}`);
    } catch (error) {
      this.logger.error('Create wallet for new user error:', error);
    }
  }
  
  /**
   * Event handler for trip completion
   */
  private async onTripCompleted(payload: { trip: any }): Promise<void> {
    try {
      await this.processRidePayment({
        tripId: payload.trip._id,
        amount: payload.trip.fareBreakdown.totalFare,
        paymentMethod: payload.trip.paymentMethod
      } as any);
    } catch (error) {
      this.logger.error('Process ride payment on trip completion error:', error);
    }
  }
  
  /**
   * Event handler for trip cancellation
   */
  private async onTripCancelled(payload: { trip: any; reason: string }): Promise<void> {
    try {
      // Process refund if payment was already made
      if (payload.trip.paymentStatus === 'completed') {
        await this.refundPayment({
          tripId: payload.trip._id,
          amount: payload.trip.fareBreakdown.totalFare,
          reason: payload.reason
        } as any);
      }
    } catch (error) {
      this.logger.error('Process refund on trip cancellation error:', error);
    }
  }
}
