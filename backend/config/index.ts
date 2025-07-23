import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export interface Config {
  // Database
  mongoUri: string;
  
  // JWT
  jwtSecret: string;
  jwtExpiresIn: string;
  
  // Server
  port: number;
  nodeEnv: string;
  
  // Payment
  stripe: {
    secretKey: string;
    publishableKey: string;
  };
  
  // Notifications
  twilio: {
    accountSid: string;
    authToken: string;
    phoneNumber: string;
  };
  
  sendgrid: {
    apiKey: string;
    fromEmail: string;
  };
  
  // Maps
  mapbox: {
    apiKey: string;
  };
  
  // WebSocket
  socketPort: number;
  
  // Rate Limiting
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
}

const config: Config = {
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/rideshare',
  jwtSecret: process.env.JWT_SECRET || 'fallback-secret-key',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  },
  
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
  },
  
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY || '',
    fromEmail: process.env.SENDGRID_FROM_EMAIL || 'noreply@rideshare.com',
  },
  
  mapbox: {
    apiKey: process.env.MAPBOX_API_KEY || '',
  },
  
  socketPort: parseInt(process.env.SOCKET_PORT || '3001', 10),
  
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },
};

// Validation
const requiredEnvVars = [
  'MONGO_URI',
  'JWT_SECRET',
  'STRIPE_SECRET_KEY',
  'TWILIO_ACCOUNT_SID',
  'SENDGRID_API_KEY',
  'MAPBOX_API_KEY'
];

if (config.nodeEnv === 'production') {
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
}

export default config;
