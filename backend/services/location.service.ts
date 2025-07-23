import { Service, ServiceBroker, Context } from 'moleculer';
import { z } from 'zod';
import axios from 'axios';
import config from '../config';

// Validation schemas
const GeocodeSchema = z.object({
  address: z.string().min(1, 'Address is required')
});

const ReverseGeocodeSchema = z.object({
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90)
});

const GetDirectionsSchema = z.object({
  origin: z.object({
    longitude: z.number(),
    latitude: z.number()
  }),
  destination: z.object({
    longitude: z.number(),
    latitude: z.number()
  }),
  profile: z.enum(['driving', 'walking', 'cycling']).default('driving')
});

const SearchPlacesSchema = z.object({
  query: z.string().min(1, 'Search query is required'),
  proximity: z.object({
    longitude: z.number(),
    latitude: z.number()
  }).optional(),
  limit: z.number().min(1).max(10).default(5)
});

export default class LocationService extends Service {
  private mapboxApiKey: string;
  private mapboxBaseUrl: string = 'https://api.mapbox.com';

  public constructor(broker: ServiceBroker) {
    super(broker);
    
    this.mapboxApiKey = config.mapbox.apiKey;
    
    this.parseServiceSchema({
      name: 'location',
      version: 1,
      
      settings: {
        mapboxApiKey: this.mapboxApiKey
      },
      
      actions: {
        // Geocode address to coordinates
        geocode: {
          rest: 'POST /geocode',
          handler: this.geocodeAddress
        },
        
        // Reverse geocode coordinates to address
        reverseGeocode: {
          rest: 'POST /reverse-geocode',
          handler: this.reverseGeocode
        },
        
        // Get directions between two points
        getDirections: {
          rest: 'POST /directions',
          handler: this.getDirections
        },
        
        // Search for places
        searchPlaces: {
          rest: 'POST /search',
          handler: this.searchPlaces
        },
        
        // Calculate distance between two points
        calculateDistance: {
          rest: 'POST /distance',
          handler: this.calculateDistance
        },
        
        // Get nearby drivers (uses driver service)
        getNearbyDrivers: {
          rest: 'GET /nearby-drivers',
          handler: this.getNearbyDrivers
        },
        
        // Update driver location (internal)
        updateDriverLocation: {
          visibility: 'private',
          handler: this.updateDriverLocation
        }
      },
      
      methods: {
        makeMapboxRequest: this.makeMapboxRequest,
        haversineDistance: this.haversineDistance,
        validateCoordinates: this.validateCoordinates
      }
    });
  }
  
  /**
   * Geocode address to coordinates
   */
  public async geocodeAddress(ctx: Context): Promise<{ coordinates: number[]; address: string; placeId?: string }> {
    try {
      const { address } = GeocodeSchema.parse(ctx.params);
      
      const response = await this.makeMapboxRequest(
        `/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json`,
        {
          limit: 1,
          types: 'address,poi'
        }
      );
      
      if (!response.features || response.features.length === 0) {
        throw new Error('Address not found');
      }
      
      const feature = response.features[0];
      
      return {
        coordinates: feature.center, // [longitude, latitude]
        address: feature.place_name,
        placeId: feature.id
      };
      
    } catch (error) {
      this.logger.error('Geocode address error:', error);
      throw new Error(error instanceof Error ? error.message : 'Geocoding failed');
    }
  }
  
  /**
   * Reverse geocode coordinates to address
   */
  public async reverseGeocode(ctx: Context): Promise<{ address: string; components: any }> {
    try {
      const { longitude, latitude } = ReverseGeocodeSchema.parse(ctx.params);
      
      this.validateCoordinates(longitude, latitude);
      
      const response = await this.makeMapboxRequest(
        `/geocoding/v5/mapbox.places/${longitude},${latitude}.json`,
        {
          limit: 1,
          types: 'address'
        }
      );
      
      if (!response.features || response.features.length === 0) {
        throw new Error('Location not found');
      }
      
      const feature = response.features[0];
      
      // Extract address components
      const components = {
        street: '',
        city: '',
        state: '',
        country: '',
        postalCode: ''
      };
      
      if (feature.context) {
        feature.context.forEach((ctx: any) => {
          if (ctx.id.startsWith('place')) {
            components.city = ctx.text;
          } else if (ctx.id.startsWith('region')) {
            components.state = ctx.text;
          } else if (ctx.id.startsWith('country')) {
            components.country = ctx.text;
          } else if (ctx.id.startsWith('postcode')) {
            components.postalCode = ctx.text;
          }
        });
      }
      
      // Extract street from address
      if (feature.address && feature.text) {
        components.street = `${feature.address} ${feature.text}`;
      }
      
      return {
        address: feature.place_name,
        components
      };
      
    } catch (error) {
      this.logger.error('Reverse geocode error:', error);
      throw new Error(error instanceof Error ? error.message : 'Reverse geocoding failed');
    }
  }
  
  /**
   * Get directions between two points
   */
  public async getDirections(ctx: Context): Promise<{ 
    distance: number; 
    duration: number; 
    route: any; 
    instructions: string[] 
  }> {
    try {
      const { origin, destination, profile } = GetDirectionsSchema.parse(ctx.params);
      
      this.validateCoordinates(origin.longitude, origin.latitude);
      this.validateCoordinates(destination.longitude, destination.latitude);
      
      const coordinates = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
      
      const response = await this.makeMapboxRequest(
        `/directions/v5/mapbox/${profile}/${coordinates}`,
        {
          geometries: 'geojson',
          steps: true,
          overview: 'full'
        }
      );
      
      if (!response.routes || response.routes.length === 0) {
        throw new Error('No route found');
      }
      
      const route = response.routes[0];
      
      // Extract turn-by-turn instructions
      const instructions: string[] = [];
      if (route.legs) {
        route.legs.forEach((leg: any) => {
          if (leg.steps) {
            leg.steps.forEach((step: any) => {
              if (step.maneuver && step.maneuver.instruction) {
                instructions.push(step.maneuver.instruction);
              }
            });
          }
        });
      }
      
      return {
        distance: Math.round(route.distance / 1000 * 100) / 100, // Convert to km and round
        duration: Math.round(route.duration / 60), // Convert to minutes
        route: route.geometry,
        instructions
      };
      
    } catch (error) {
      this.logger.error('Get directions error:', error);
      throw new Error(error instanceof Error ? error.message : 'Failed to get directions');
    }
  }
  
  /**
   * Search for places
   */
  public async searchPlaces(ctx: Context): Promise<{ places: any[] }> {
    try {
      const { query, proximity, limit } = SearchPlacesSchema.parse(ctx.params);
      
      const params: any = {
        limit,
        types: 'poi,address'
      };
      
      if (proximity) {
        this.validateCoordinates(proximity.longitude, proximity.latitude);
        params.proximity = `${proximity.longitude},${proximity.latitude}`;
      }
      
      const response = await this.makeMapboxRequest(
        `/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`,
        params
      );
      
      const places = response.features?.map((feature: any) => ({
        id: feature.id,
        name: feature.text,
        address: feature.place_name,
        coordinates: feature.center,
        category: feature.properties?.category,
        distance: feature.properties?.distance
      })) || [];
      
      return { places };
      
    } catch (error) {
      this.logger.error('Search places error:', error);
      throw new Error(error instanceof Error ? error.message : 'Place search failed');
    }
  }
  
  /**
   * Calculate distance between two points
   */
  public async calculateDistance(ctx: Context): Promise<{ 
    distance: number; 
    unit: string; 
    straightLine: boolean 
  }> {
    try {
      const { origin, destination } = ctx.params as any;
      
      if (!origin?.latitude || !origin?.longitude || !destination?.latitude || !destination?.longitude) {
        throw new Error('Origin and destination coordinates are required');
      }
      
      this.validateCoordinates(origin.longitude, origin.latitude);
      this.validateCoordinates(destination.longitude, destination.latitude);
      
      const distance = this.haversineDistance(
        origin.latitude,
        origin.longitude,
        destination.latitude,
        destination.longitude
      );
      
      return {
        distance: Math.round(distance * 100) / 100,
        unit: 'km',
        straightLine: true
      };
      
    } catch (error) {
      this.logger.error('Calculate distance error:', error);
      throw new Error(error instanceof Error ? error.message : 'Distance calculation failed');
    }
  }
  
  /**
   * Get nearby drivers
   */
  public async getNearbyDrivers(ctx: Context): Promise<{ drivers: any[] }> {
    const { longitude, latitude, radius = 5000, vehicleType } = ctx.params as any;
    
    if (!longitude || !latitude) {
      throw new Error('Longitude and latitude are required');
    }
    
    try {
      this.validateCoordinates(parseFloat(longitude), parseFloat(latitude));
      
      // Call driver service to get nearby drivers
      const result = await this.broker.call('driver.getNearby', {
        longitude: parseFloat(longitude),
        latitude: parseFloat(latitude),
        radius: parseInt(radius),
        vehicleType
      });
      
      return result as any;
      
    } catch (error) {
      this.logger.error('Get nearby drivers error:', error);
      throw new Error('Failed to get nearby drivers');
    }
  }
  
  /**
   * Update driver location (internal)
   */
  public async updateDriverLocation(ctx: Context<{ 
    driverId: string; 
    longitude: number; 
    latitude: number; 
    address?: string 
  }>): Promise<{ success: boolean }> {
    const { driverId, longitude, latitude, address } = ctx.params;
    
    try {
      this.validateCoordinates(longitude, latitude);
      
      // Get address if not provided
      let locationAddress = address;
      if (!locationAddress) {
        try {
          const reverseGeoResult = await this.reverseGeocode({
            longitude,
            latitude
          } as any);
          locationAddress = reverseGeoResult.address;
        } catch (error) {
          this.logger.warn('Failed to reverse geocode driver location:', error);
          locationAddress = `${latitude}, ${longitude}`;
        }
      }
      
      // Update driver location via driver service
      await this.broker.call('driver.updateLocation', {
        longitude,
        latitude,
        address: locationAddress
      });
      
      return { success: true };
      
    } catch (error) {
      this.logger.error('Update driver location error:', error);
      return { success: false };
    }
  }
  
  /**
   * Make request to Mapbox API
   */
  private async makeMapboxRequest(endpoint: string, params: any = {}): Promise<any> {
    try {
      const url = `${this.mapboxBaseUrl}${endpoint}`;
      const queryParams = {
        ...params,
        access_token: this.mapboxApiKey
      };
      
      const response = await axios.get(url, {
        params: queryParams,
        timeout: 10000
      });
      
      return response.data;
      
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Invalid Mapbox API key');
        } else if (error.response?.status === 429) {
          throw new Error('Mapbox API rate limit exceeded');
        } else {
          throw new Error(`Mapbox API error: ${error.response?.data?.message || error.message}`);
        }
      }
      throw error;
    }
  }
  
  /**
   * Calculate distance using Haversine formula
   */
  private haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
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
   * Validate coordinates
   */
  private validateCoordinates(longitude: number, latitude: number): void {
    if (isNaN(longitude) || isNaN(latitude)) {
      throw new Error('Invalid coordinates: must be numbers');
    }
    
    if (longitude < -180 || longitude > 180) {
      throw new Error('Invalid longitude: must be between -180 and 180');
    }
    
    if (latitude < -90 || latitude > 90) {
      throw new Error('Invalid latitude: must be between -90 and 90');
    }
  }
}
