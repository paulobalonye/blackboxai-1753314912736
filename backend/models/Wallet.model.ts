import mongoose, { Document, Schema } from 'mongoose';
import { IUser } from './User.model';

export enum TransactionType {
  CREDIT = 'credit',
  DEBIT = 'debit'
}

export enum TransactionStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

export enum TransactionCategory {
  RIDE_PAYMENT = 'ride_payment',
  RIDE_EARNING = 'ride_earning',
  WALLET_TOPUP = 'wallet_topup',
  WITHDRAWAL = 'withdrawal',
  REFUND = 'refund',
  TIP = 'tip',
  BONUS = 'bonus',
  PENALTY = 'penalty'
}

export interface ITransaction {
  _id: mongoose.Types.ObjectId;
  type: TransactionType;
  amount: number;
  category: TransactionCategory;
  status: TransactionStatus;
  description: string;
  referenceId?: string; // Trip ID, Payment ID, etc.
  paymentMethod?: string;
  paymentGatewayResponse?: any;
  createdAt: Date;
  completedAt?: Date;
}

export interface IWallet extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId | IUser;
  balance: number;
  currency: string;
  isActive: boolean;
  transactions: ITransaction[];
  
  // Limits and restrictions
  dailyLimit: number;
  monthlyLimit: number;
  dailySpent: number;
  monthlySpent: number;
  lastResetDate: Date;
  
  createdAt: Date;
  updatedAt: Date;
  
  // Methods
  addTransaction(transaction: Partial<ITransaction>): Promise<IWallet>;
  debit(amount: number, category: TransactionCategory, description: string, referenceId?: string): Promise<boolean>;
  credit(amount: number, category: TransactionCategory, description: string, referenceId?: string): Promise<boolean>;
  getTransactionHistory(limit?: number, offset?: number): ITransaction[];
  canSpend(amount: number): boolean;
  resetLimits(): void;
}

const TransactionSchema = new Schema<ITransaction>({
  type: {
    type: String,
    enum: Object.values(TransactionType),
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  category: {
    type: String,
    enum: Object.values(TransactionCategory),
    required: true
  },
  status: {
    type: String,
    enum: Object.values(TransactionStatus),
    default: TransactionStatus.PENDING
  },
  description: {
    type: String,
    required: true,
    maxlength: 255
  },
  referenceId: {
    type: String,
    index: true
  },
  paymentMethod: {
    type: String
  },
  paymentGatewayResponse: {
    type: Schema.Types.Mixed
  },
  completedAt: {
    type: Date
  }
}, {
  timestamps: true
});

const WalletSchema = new Schema<IWallet>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  balance: {
    type: Number,
    default: 0,
    min: 0
  },
  currency: {
    type: String,
    default: 'USD',
    uppercase: true,
    length: 3
  },
  isActive: {
    type: Boolean,
    default: true
  },
  transactions: [TransactionSchema],
  dailyLimit: {
    type: Number,
    default: 500, // $500 daily limit
    min: 0
  },
  monthlyLimit: {
    type: Number,
    default: 5000, // $5000 monthly limit
    min: 0
  },
  dailySpent: {
    type: Number,
    default: 0,
    min: 0
  },
  monthlySpent: {
    type: Number,
    default: 0,
    min: 0
  },
  lastResetDate: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes
WalletSchema.index({ userId: 1 });
WalletSchema.index({ 'transactions.referenceId': 1 });
WalletSchema.index({ 'transactions.status': 1 });
WalletSchema.index({ 'transactions.createdAt': -1 });

// Instance method to add transaction
WalletSchema.methods.addTransaction = async function(transactionData: Partial<ITransaction>): Promise<IWallet> {
  const transaction: ITransaction = {
    _id: new mongoose.Types.ObjectId(),
    type: transactionData.type!,
    amount: transactionData.amount!,
    category: transactionData.category!,
    status: transactionData.status || TransactionStatus.PENDING,
    description: transactionData.description!,
    referenceId: transactionData.referenceId,
    paymentMethod: transactionData.paymentMethod,
    paymentGatewayResponse: transactionData.paymentGatewayResponse,
    createdAt: new Date(),
    completedAt: transactionData.status === TransactionStatus.COMPLETED ? new Date() : undefined
  };
  
  this.transactions.push(transaction);
  
  // Update balance if transaction is completed
  if (transaction.status === TransactionStatus.COMPLETED) {
    if (transaction.type === TransactionType.CREDIT) {
      this.balance += transaction.amount;
    } else if (transaction.type === TransactionType.DEBIT) {
      this.balance -= transaction.amount;
      this.dailySpent += transaction.amount;
      this.monthlySpent += transaction.amount;
    }
  }
  
  return this.save();
};

// Instance method to debit amount
WalletSchema.methods.debit = async function(
  amount: number, 
  category: TransactionCategory, 
  description: string, 
  referenceId?: string
): Promise<boolean> {
  // Check if wallet is active
  if (!this.isActive) {
    throw new Error('Wallet is not active');
  }
  
  // Check if sufficient balance
  if (this.balance < amount) {
    throw new Error('Insufficient balance');
  }
  
  // Check spending limits
  if (!this.canSpend(amount)) {
    throw new Error('Transaction exceeds spending limits');
  }
  
  try {
    await this.addTransaction({
      type: TransactionType.DEBIT,
      amount,
      category,
      description,
      referenceId,
      status: TransactionStatus.COMPLETED
    });
    return true;
  } catch (error) {
    throw new Error(`Debit transaction failed: ${error}`);
  }
};

// Instance method to credit amount
WalletSchema.methods.credit = async function(
  amount: number, 
  category: TransactionCategory, 
  description: string, 
  referenceId?: string
): Promise<boolean> {
  // Check if wallet is active
  if (!this.isActive) {
    throw new Error('Wallet is not active');
  }
  
  try {
    await this.addTransaction({
      type: TransactionType.CREDIT,
      amount,
      category,
      description,
      referenceId,
      status: TransactionStatus.COMPLETED
    });
    return true;
  } catch (error) {
    throw new Error(`Credit transaction failed: ${error}`);
  }
};

// Instance method to get transaction history
WalletSchema.methods.getTransactionHistory = function(limit: number = 50, offset: number = 0): ITransaction[] {
  return this.transactions
    .sort((a: ITransaction, b: ITransaction) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(offset, offset + limit);
};

// Instance method to check spending limits
WalletSchema.methods.canSpend = function(amount: number): boolean {
  this.resetLimits(); // Reset limits if needed
  
  return (this.dailySpent + amount <= this.dailyLimit) && 
         (this.monthlySpent + amount <= this.monthlyLimit);
};

// Instance method to reset spending limits
WalletSchema.methods.resetLimits = function(): void {
  const now = new Date();
  const lastReset = new Date(this.lastResetDate);
  
  // Reset daily limit if it's a new day
  if (now.getDate() !== lastReset.getDate() || 
      now.getMonth() !== lastReset.getMonth() || 
      now.getFullYear() !== lastReset.getFullYear()) {
    this.dailySpent = 0;
  }
  
  // Reset monthly limit if it's a new month
  if (now.getMonth() !== lastReset.getMonth() || 
      now.getFullYear() !== lastReset.getFullYear()) {
    this.monthlySpent = 0;
  }
  
  this.lastResetDate = now;
};

// Pre-save middleware to ensure balance consistency
WalletSchema.pre('save', function(next) {
  // Ensure balance is not negative
  if (this.balance < 0) {
    this.balance = 0;
  }
  
  // Round balance to 2 decimal places
  this.balance = Math.round(this.balance * 100) / 100;
  
  next();
});

export const Wallet = mongoose.model<IWallet>('Wallet', WalletSchema);
