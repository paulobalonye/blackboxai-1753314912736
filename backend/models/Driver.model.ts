import mongoose, { Document, Schema } from 'mongoose';
import { IUser, UserRole } from './User.model';

export enum DriverStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended'
}

export enum DriverAvailability {
  ONLINE = 'online',
  OFFLINE = 'offline',
  BUSY = 'busy'
}

export enum VehicleType {
  SEDAN = 'sedan',
  SUV = 'suv',
  HATCHBACK = 'hatchback',
  LUXURY = 'luxury',
  BIKE = 'bike'
}

export interface IVehicle {
  make: string;
  model: string;
  year: number;
  color: string;
  licensePlate: string;
  type: VehicleType;
  capacity: number;
  registrationNumber: string;
  insuranceNumber: string;
  insuranceExpiry: Date;
}

export interface IDriverDocuments {
  driverLicense: {
    number: string;
    expiryDate: Date;
    imageUrl?: string;
  };
  vehicleRegistration: {
    number: string;
    expiryDate: Date;
    imageUrl?: string;
  };
  insurance: {
    policyNumber: string;
    expiryDate: Date;
    imageUrl?: string;
  };
  backgroundCheck?: {
    status: 'pending' | 'approved' | 'rejected';
    completedAt?: Date;
    reportUrl?: string;
  };
}

export interface IDriverLocation {
  type: 'Point';
  coordinates: [number, number]; // [longitude, latitude]
  address?: string;
  lastUpdated: Date;
}

export interface IDriverStats {
  totalTrips: number;
  totalEarnings: number;
  averageRating: number;
  totalRatings: number;
  completionRate: number;
  cancellationRate: number;
}

export interface IDriver extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId | IUser;
  driverStatus: DriverStatus;
  availability: DriverAvailability;
  vehicle: IVehicle;
  documents: IDriverDocuments;
  currentLocation?: IDriverLocation;
  homeLocation?: IDriverLocation;
  stats: IDriverStats;
  bankAccount?: {
    accountNumber: string;
    routingNumber: string;
    accountHolderName: string;
  };
  approvedAt?: Date;
  approvedBy?: mongoose.Types.ObjectId;
  rejectedAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
  
  // Methods
  updateLocation(longitude: number, latitude: number, address?: string): void;
  calculateDistance(targetLat: number, targetLng: number): number;
  isAvailableForRide(): boolean;
}

const VehicleSchema = new Schema<IVehicle>({
  make: { type: String, required: true, trim: true },
  model: { type: String, required: true, trim: true },
  year: { 
    type: Number, 
    required: true,
    min: 2010,
    max: new Date().getFullYear() + 1
  },
  color: { type: String, required: true, trim: true },
  licensePlate: { 
    type: String, 
    required: true, 
    unique: true,
    uppercase: true,
    trim: true
  },
  type: {
    type: String,
    enum: Object.values(VehicleType),
    required: true
  },
  capacity: { 
    type: Number, 
    required: true,
    min: 1,
    max: 8
  },
  registrationNumber: { type: String, required: true, unique: true },
  insuranceNumber: { type: String, required: true },
  insuranceExpiry: { 
    type: Date, 
    required: true,
    validate: {
      validator: function(date: Date) {
        return date > new Date();
      },
      message: 'Insurance must not be expired'
    }
  }
});

const DriverDocumentsSchema = new Schema<IDriverDocuments>({
  driverLicense: {
    number: { type: String, required: true, unique: true },
    expiryDate: { 
      type: Date, 
      required: true,
      validate: {
        validator: function(date: Date) {
          return date > new Date();
        },
        message: 'Driver license must not be expired'
      }
    },
    imageUrl: { type: String }
  },
  vehicleRegistration: {
    number: { type: String, required: true },
    expiryDate: { type: Date, required: true },
    imageUrl: { type: String }
  },
  insurance: {
    policyNumber: { type: String, required: true },
    expiryDate: { type: Date, required: true },
    imageUrl: { type: String }
  },
  backgroundCheck: {
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending'
    },
    completedAt: { type: Date },
    reportUrl: { type: String }
  }
});

const LocationSchema = new Schema<IDriverLocation>({
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
  address: { type: String },
  lastUpdated: { type: Date, default: Date.now }
});

const DriverStatsSchema = new Schema<IDriverStats>({
  totalTrips: { type: Number, default: 0, min: 0 },
  totalEarnings: { type: Number, default: 0, min: 0 },
  averageRating: { type: Number, default: 0, min: 0, max: 5 },
  totalRatings: { type: Number, default: 0, min: 0 },
  completionRate: { type: Number, default: 0, min: 0, max: 100 },
  cancellationRate: { type: Number, default: 0, min: 0, max: 100 }
});

const DriverSchema = new Schema<IDriver>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  driverStatus: {
    type: String,
    enum: Object.values(DriverStatus),
    default: DriverStatus.PENDING
  },
  availability: {
    type: String,
    enum: Object.values(DriverAvailability),
    default: DriverAvailability.OFFLINE
  },
  vehicle: {
    type: VehicleSchema,
    required: true
  },
  documents: {
    type: DriverDocumentsSchema,
    required: true
  },
  currentLocation: LocationSchema,
  homeLocation: LocationSchema,
  stats: {
    type: DriverStatsSchema,
    default: () => ({})
  },
  bankAccount: {
    accountNumber: { type: String },
    routingNumber: { type: String },
    accountHolderName: { type: String }
  },
  approvedAt: { type: Date },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: { type: Date },
  rejectionReason: { type: String }
}, {
  timestamps: true
});

// Indexes
DriverSchema.index({ userId: 1 });
DriverSchema.index({ driverStatus: 1 });
DriverSchema.index({ availability: 1 });
DriverSchema.index({ 'vehicle.licensePlate': 1 });
DriverSchema.index({ 'documents.driverLicense.number': 1 });
DriverSchema.index({ currentLocation: '2dsphere' });

// Instance method to update location
DriverSchema.methods.updateLocation = function(longitude: number, latitude: number, address?: string): void {
  this.currentLocation = {
    type: 'Point',
    coordinates: [longitude, latitude],
    address,
    lastUpdated: new Date()
  };
};

// Instance method to calculate distance (Haversine formula)
DriverSchema.methods.calculateDistance = function(targetLat: number, targetLng: number): number {
  if (!this.currentLocation) return Infinity;
  
  const [lng, lat] = this.currentLocation.coordinates;
  const R = 6371; // Earth's radius in kilometers
  
  const dLat = (targetLat - lat) * Math.PI / 180;
  const dLng = (targetLng - lng) * Math.PI / 180;
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat * Math.PI / 180) * Math.cos(targetLat * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Instance method to check availability
DriverSchema.methods.isAvailableForRide = function(): boolean {
  return this.driverStatus === DriverStatus.APPROVED && 
         this.availability === DriverAvailability.ONLINE;
};

export const Driver = mongoose.model<IDriver>('Driver', DriverSchema);
