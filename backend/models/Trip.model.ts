import mongoose, { Document, Schema } from 'mongoose';
import { IUser } from './User.model';
import { IDriver } from './Driver.model';

export enum TripStatus {
  REQUESTED = 'requested',
  ACCEPTED = 'accepted',
  DRIVER_ARRIVED = 'driver_arrived',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled'
}

export enum PaymentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded'
}

export enum PaymentMethod {
  WALLET = 'wallet',
  CREDIT_CARD = 'credit_card',
  CASH = 'cash'
}

export interface ILocation {
  type: 'Point';
  coordinates: [number, number]; // [longitude, latitude]
  address: string;
  placeId?: string;
}

export interface IFareBreakdown {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  surgeMultiplier: number;
  discount: number;
  tax: number;
  tip: number;
  totalFare: number;
}

export interface ITripRating {
  passengerRating?: {
    rating: number;
    comment?: string;
    ratedAt: Date;
  };
  driverRating?: {
    rating: number;
    comment?: string;
    ratedAt: Date;
  };
}

export interface ITrip extends Document {
  _id: mongoose.Types.ObjectId;
  passengerId: mongoose.Types.ObjectId | IUser;
  driverId?: mongoose.Types.ObjectId | IDriver;
  
  // Trip Details
  status: TripStatus;
  pickupLocation: ILocation;
  dropoffLocation: ILocation;
  estimatedDistance: number; // in kilometers
  estimatedDuration: number; // in minutes
  actualDistance?: number;
  actualDuration?: number;
  
  // Fare Information
  fareBreakdown: IFareBreakdown;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  paymentTransactionId?: string;
  
  // Trip Timeline
  requestedAt: Date;
  acceptedAt?: Date;
  driverArrivedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;
  cancelledBy?: 'passenger' | 'driver' | 'system';
  
  // Additional Information
  specialInstructions?: string;
  vehicleType: string;
  ratings?: ITripRating;
  
  // Route tracking (optional - for live tracking)
  route?: {
    coordinates: [number, number][];
    timestamps: Date[];
  };
  
  createdAt: Date;
  updatedAt: Date;
  
  // Methods
  calculateFare(): IFareBreakdown;
  updateStatus(newStatus: TripStatus): void;
  canBeCancelled(): boolean;
  getDuration(): number;
}

const LocationSchema = new Schema<ILocation>({
  type: {
    type: String,
    enum: ['Point'],
    default: 'Point'
  },
  coordinates: {
    type: [Number],
    required: true,
    validate: {
      validator: function(coords: number[]) {
        return coords.length === 2 && 
               coords[0] >= -180 && coords[0] <= 180 && // longitude
               coords[1] >= -90 && coords[1] <= 90;     // latitude
      },
      message: 'Invalid coordinates'
    }
  },
  address: { type: String, required: true },
  placeId: { type: String }
});

const FareBreakdownSchema = new Schema<IFareBreakdown>({
  baseFare: { type: Number, required: true, min: 0 },
  distanceFare: { type: Number, required: true, min: 0 },
  timeFare: { type: Number, required: true, min: 0 },
  surgeMultiplier: { type: Number, default: 1, min: 1 },
  discount: { type: Number, default: 0, min: 0 },
  tax: { type: Number, required: true, min: 0 },
  tip: { type: Number, default: 0, min: 0 },
  totalFare: { type: Number, required: true, min: 0 }
});

const RatingSchema = new Schema({
  rating: { 
    type: Number, 
    required: true, 
    min: 1, 
    max: 5 
  },
  comment: { 
    type: String, 
    maxlength: 500 
  },
  ratedAt: { 
    type: Date, 
    default: Date.now 
  }
});

const TripRatingSchema = new Schema<ITripRating>({
  passengerRating: RatingSchema,
  driverRating: RatingSchema
});

const TripSchema = new Schema<ITrip>({
  passengerId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  driverId: {
    type: Schema.Types.ObjectId,
    ref: 'Driver'
  },
  status: {
    type: String,
    enum: Object.values(TripStatus),
    default: TripStatus.REQUESTED
  },
  pickupLocation: {
    type: LocationSchema,
    required: true
  },
  dropoffLocation: {
    type: LocationSchema,
    required: true
  },
  estimatedDistance: {
    type: Number,
    required: true,
    min: 0
  },
  estimatedDuration: {
    type: Number,
    required: true,
    min: 0
  },
  actualDistance: {
    type: Number,
    min: 0
  },
  actualDuration: {
    type: Number,
    min: 0
  },
  fareBreakdown: {
    type: FareBreakdownSchema,
    required: true
  },
  paymentMethod: {
    type: String,
    enum: Object.values(PaymentMethod),
    required: true
  },
  paymentStatus: {
    type: String,
    enum: Object.values(PaymentStatus),
    default: PaymentStatus.PENDING
  },
  paymentTransactionId: {
    type: String
  },
  requestedAt: {
    type: Date,
    default: Date.now
  },
  acceptedAt: {
    type: Date
  },
  driverArrivedAt: {
    type: Date
  },
  startedAt: {
    type: Date
  },
  completedAt: {
    type: Date
  },
  cancelledAt: {
    type: Date
  },
  cancellationReason: {
    type: String,
    maxlength: 500
  },
  cancelledBy: {
    type: String,
    enum: ['passenger', 'driver', 'system']
  },
  specialInstructions: {
    type: String,
    maxlength: 500
  },
  vehicleType: {
    type: String,
    required: true
  },
  ratings: TripRatingSchema,
  route: {
    coordinates: [[Number]],
    timestamps: [Date]
  }
}, {
  timestamps: true
});

// Indexes
TripSchema.index({ passengerId: 1 });
TripSchema.index({ driverId: 1 });
TripSchema.index({ status: 1 });
TripSchema.index({ requestedAt: -1 });
TripSchema.index({ pickupLocation: '2dsphere' });
TripSchema.index({ dropoffLocation: '2dsphere' });
TripSchema.index({ paymentStatus: 1 });

// Instance method to calculate fare
TripSchema.methods.calculateFare = function(): IFareBreakdown {
  const baseFare = 2.50; // Base fare in USD
  const perKmRate = 1.20; // Rate per kilometer
  const perMinuteRate = 0.25; // Rate per minute
  const taxRate = 0.08; // 8% tax
  
  const distanceFare = this.estimatedDistance * perKmRate;
  const timeFare = this.estimatedDuration * perMinuteRate;
  const subtotal = (baseFare + distanceFare + timeFare) * this.fareBreakdown.surgeMultiplier;
  const discountAmount = this.fareBreakdown.discount || 0;
  const tax = (subtotal - discountAmount) * taxRate;
  const tip = this.fareBreakdown.tip || 0;
  const totalFare = subtotal - discountAmount + tax + tip;
  
  return {
    baseFare,
    distanceFare,
    timeFare,
    surgeMultiplier: this.fareBreakdown.surgeMultiplier,
    discount: discountAmount,
    tax,
    tip,
    totalFare: Math.round(totalFare * 100) / 100 // Round to 2 decimal places
  };
};

// Instance method to update status
TripSchema.methods.updateStatus = function(newStatus: TripStatus): void {
  const now = new Date();
  this.status = newStatus;
  
  switch (newStatus) {
    case TripStatus.ACCEPTED:
      this.acceptedAt = now;
      break;
    case TripStatus.DRIVER_ARRIVED:
      this.driverArrivedAt = now;
      break;
    case TripStatus.IN_PROGRESS:
      this.startedAt = now;
      break;
    case TripStatus.COMPLETED:
      this.completedAt = now;
      this.paymentStatus = PaymentStatus.PROCESSING;
      break;
    case TripStatus.CANCELLED:
      this.cancelledAt = now;
      break;
  }
};

// Instance method to check if trip can be cancelled
TripSchema.methods.canBeCancelled = function(): boolean {
  return [TripStatus.REQUESTED, TripStatus.ACCEPTED, TripStatus.DRIVER_ARRIVED].includes(this.status);
};

// Instance method to get trip duration
TripSchema.methods.getDuration = function(): number {
  if (this.completedAt && this.startedAt) {
    return Math.round((this.completedAt.getTime() - this.startedAt.getTime()) / (1000 * 60)); // in minutes
  }
  return 0;
};

// Pre-save middleware to calculate fare
TripSchema.pre('save', function(next) {
  if (this.isNew || this.isModified('estimatedDistance') || this.isModified('estimatedDuration')) {
    this.fareBreakdown = this.calculateFare();
  }
  next();
});

export const Trip = mongoose.model<ITrip>('Trip', TripSchema);
