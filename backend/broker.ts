import { ServiceBroker } from 'moleculer';
import ApiGateway from 'moleculer-web';
import mongoose from 'mongoose';
import config from './config';
import { webSocketServer } from './websocket/server';

// Create broker
const broker = new ServiceBroker({
  nodeID: 'rideshare-backend',
  transporter: process.env.NODE_ENV === 'production' ? 'NATS' : null,
  logger: {
    type: 'Console',
    options: {
      level: 'info',
      colors: true,
      moduleColors: false,
      formatter: 'full',
      objectPrinter: null,
      autoPadding: false
    }
  },
  logLevel: 'info',
  requestTimeout: 10 * 1000,
  retryPolicy: {
    enabled: false,
    retries: 5,
    delay: 100,
    maxDelay: 1000,
    factor: 2,
    check: (err: any) => err && !!err.retryable
  },
  maxCallLevel: 100,
  heartbeatInterval: 10,
  heartbeatTimeout: 30,
  contextParamsCloning: false,
  tracking: {
    enabled: false,
    shutdownTimeout: 5000
  },
  disableBalancer: false,
  registry: {
    strategy: 'RoundRobin',
    preferLocal: true
  },
  circuitBreaker: {
    enabled: false,
    threshold: 0.5,
    minRequestCount: 20,
    windowTime: 60,
    halfOpenTime: 10 * 1000,
    check: (err: any) => err && err.code >= 500
  },
  bulkhead: {
    enabled: false,
    concurrency: 10,
    maxQueueSize: 100
  },
  validator: true,
  metrics: {
    enabled: false,
    reporter: {
      type: 'Prometheus',
      options: {
        port: 3030,
        endpoint: '/metrics'
      }
    }
  },
  tracing: {
    enabled: false,
    exporter: {
      type: 'Console',
      options: {
        logger: null,
        colors: true,
        width: 100,
        gaugeWidth: 40
      }
    }
  }
});

// Connect to MongoDB
async function connectDB() {
  try {
    await mongoose.connect(config.mongoUri);
    broker.logger.info('✅ Connected to MongoDB successfully');
  } catch (error) {
    broker.logger.error('❌ MongoDB connection failed:', error);
    process.exit(1);
  }
}

// Create API Gateway service
broker.createService({
  name: 'api',
  mixins: [ApiGateway],
  settings: {
    port: config.port,
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    },
    routes: [
      {
        path: '/api',
        whitelist: [
          'auth.*',
          'user.*',
          'driver.*',
          'ride.*',
          'payment.*',
          'notification.*',
          'location.*'
        ],
        use: [],
        mergeParams: true,
        authentication: false,
        authorization: true,
        autoAliases: true,
        aliases: {},
        callingOptions: {},
        bodyParsers: {
          json: {
            strict: false,
            limit: '1MB'
          },
          urlencoded: {
            extended: true,
            limit: '1MB'
          }
        },
        mappingPolicy: 'all',
        logging: true
      }
    ],
    log4XXResponses: false,
    logRequestParams: null,
    logResponseData: null,
    assets: {
      folder: 'public',
      options: {}
    }
  },
  methods: {
    authenticate: async (ctx: any, route: any, req: any): Promise<any> => {
      const auth = req.headers.authorization;
      
      if (!auth) {
        return Promise.resolve(null);
      }
      
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
      
      try {
        const user = await broker.call('auth.verifyToken', { token });
        return Promise.resolve(user);
      } catch (error) {
        return Promise.resolve(null);
      }
    },
    
    authorize: async (ctx: any, route: any, req: any): Promise<boolean> => {
      // Check if route requires authentication
      const action = ctx.action;
      
      if (action && action.auth === 'required') {
        if (!req.$ctx.meta.user) {
          throw new Error('Authentication required');
        }
      }
      
      return Promise.resolve(true);
    }
  }
});

// Load services
broker.loadServices('./services', '*.service.ts');

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  broker.logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  broker.logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  broker.logger.info('🛑 Shutting down gracefully...');
  
  try {
    // Shutdown WebSocket server
    webSocketServer.shutdown();
    
    await broker.stop();
    await mongoose.connection.close();
    broker.logger.info('✅ Shutdown completed');
    process.exit(0);
  } catch (error) {
    broker.logger.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
});

// Start the application
async function startApp() {
  try {
    // Connect to database first
    await connectDB();
    
    // Start the broker
    await broker.start();
    
    broker.logger.info('🚀 Rideshare Backend started successfully');
    broker.logger.info(`📡 HTTP Server running on port ${config.port}`);
    broker.logger.info(`🔌 WebSocket Server running on port ${config.socketPort}`);
    broker.logger.info(`🌍 Environment: ${config.nodeEnv}`);
    
  } catch (error) {
    broker.logger.error('❌ Failed to start application:', error);
    process.exit(1);
  }
}

// Start the application
startApp();

export default broker;
