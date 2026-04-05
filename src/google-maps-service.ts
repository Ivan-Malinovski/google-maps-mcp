// Google Maps API Service for Cloudflare Workers
// Calls Google Maps REST APIs directly via fetch()

import { MapsError, MapsErrorMessages } from "./errors";

interface GeocodingResult {
  geometry: {
    location: { lat: number; lng: number };
    location_type: string;
    viewport?: { northeast: { lat: number; lng: number }; southwest: { lat: number; lng: number } };
  };
  formatted_address: string;
  place_id: string;
  types: string[];
}

interface GeocodingResponse {
  status: string;
  results: GeocodingResult[];
  error_message?: string;
}

interface PlaceResult {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  types?: string[];
  photos?: Array<{ photoUri?: string; heightPx?: number; widthPx?: number }>;
  currentOpeningHours?: { openNow?: boolean };
  businessStatus?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: any;
  editorialSummary?: { text: string };
  reviews?: any[];
  addressComponents?: any[];
}

interface PlacesSearchResponse {
  places?: PlaceResult[];
  error?: { message: string };
}

interface DirectionsResponse {
  status: string;
  routes?: any[];
  error_message?: string;
}

interface DistanceMatrixResponse {
  status: string;
  rows?: any[];
  error_message?: string;
}

interface ElevationResponse {
  status: string;
  results?: Array<{ elevation: number; location: { lat: number; lng: number } }>;
  error_message?: string;
}

interface TimezoneResponse {
  status: string;
  timeZoneId?: string;
  timeZoneName?: string;
  dstOffset?: number;
  rawOffset?: number;
  errorMessage?: string;
}

interface WeatherResponse {
  latitude: number;
  longitude: number;
  current?: any;
  daily?: any;
  hourly?: any;
}

export class GoogleMapsService {
  private apiKey: string;
  private geocodeCache: Map<string, { data: GeocodingResult[]; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 3600000; // 1 hour

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private getCachedGeocode(address: string): GeocodingResult[] | null {
    const cached = this.geocodeCache.get(address);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }
    return null;
  }

  private setCachedGeocode(address: string, data: GeocodingResult[]): void {
    if (this.geocodeCache.size > 100) {
      const oldestKey = this.geocodeCache.keys().next().value;
      if (oldestKey) this.geocodeCache.delete(oldestKey);
    }
    this.geocodeCache.set(address, { data, timestamp: Date.now() });
  }

  async geocode(address: string): Promise<{ success: boolean; data?: GeocodingResult[]; error?: string }> {
    const cached = this.getCachedGeocode(address);
    if (cached) {
      return { success: true, data: cached };
    }

    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", this.apiKey);
    
    const response = await fetch(url.toString());
    const data = await response.json() as GeocodingResponse;
    
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return { success: false, error: data.error_message || data.status };
    }
    
    this.setCachedGeocode(address, data.results);
    return { success: true, data: data.results };
  }

  async reverseGeocode(latitude: number, longitude: number): Promise<{ success: boolean; data?: GeocodingResult[]; error?: string }> {
    const cacheKey = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
    const cached = this.getCachedGeocode(cacheKey);
    if (cached) {
      return { success: true, data: cached };
    }

    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("latlng", `${latitude},${longitude}`);
    url.searchParams.set("key", this.apiKey);
    
    const response = await fetch(url.toString());
    const data = await response.json() as GeocodingResponse;
    
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return { success: false, error: data.error_message || data.status };
    }
     
    this.setCachedGeocode(cacheKey, data.results);
    return { success: true, data: data.results };
  }

  async searchNearby(params: {
    center: { value: string; isCoordinates?: boolean };
    radius?: number;
    keyword?: string;
    type?: string;
    minRating?: number;
    openNow?: boolean;
    maxResults?: number;
  }): Promise<{ success: boolean; data?: PlaceResult[]; error?: string }> {
    const url = new URL("https://places.googleapis.com/v1/places:searchNearby");
    
    const isCoordinates = params.center.isCoordinates ?? false;
    let location: { latitude: number; longitude: number };
    if (isCoordinates) {
      const [lat, lng] = params.center.value.split(",").map(Number);
      location = { latitude: lat, longitude: lng };
    } else {
      const geocoded = await this.geocode(params.center.value);
      if (!geocoded.success || !geocoded.data?.[0]) {
        return { success: false, error: "Failed to geocode center location" };
      }
      location = {
        latitude: geocoded.data[0].geometry.location.lat,
        longitude: geocoded.data[0].geometry.location.lng,
      };
    }

    const body: any = {
      locationRestriction: {
        circle: {
          center: location,
          radius: params.radius || 2000,
        },
      },
    };

    if (params.keyword) {
      body.textQuery = params.keyword;
    }
    if (params.type) {
      body.includedTypes = [params.type];
    }

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.types,places.id,places.currentOpeningHours,places.businessStatus",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json() as PlacesSearchResponse;
    
    let places = data.places || [];
    
    if (params.minRating !== undefined) {
      places = places.filter((p: PlaceResult) => (p.rating ?? 0) >= params.minRating!);
    }
    
    if (params.openNow) {
      places = places.filter((p: PlaceResult) => p.currentOpeningHours?.openNow);
    }
    
    return { success: true, data: places.slice(0, params.maxResults || 20) };
  }

  async searchPlaces(params: {
    query: string;
    locationBias?: { latitude: number; longitude: number; radius?: number };
    openNow?: boolean;
    minRating?: number;
    includedType?: string;
    maxResults?: number;
  }): Promise<{ success: boolean; data?: PlaceResult[]; error?: string }> {
    const url = new URL("https://places.googleapis.com/v1/places:searchText");
    
    const body: any = { textQuery: params.query };

    if (params.locationBias) {
      body.locationBias = {
        circle: {
          center: {
            latitude: params.locationBias.latitude,
            longitude: params.locationBias.longitude,
          },
          radius: params.locationBias.radius || 50000,
        },
      };
    }

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.types,places.id,places.currentOpeningHours,places.businessStatus",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json() as PlacesSearchResponse;
    
    let places = data.places || [];
    
    if (params.minRating !== undefined) {
      places = places.filter((p: PlaceResult) => (p.rating ?? 0) >= params.minRating!);
    }
    
    if (params.openNow) {
      places = places.filter((p: PlaceResult) => p.currentOpeningHours?.openNow);
    }
    
    if (params.includedType) {
      places = places.filter((p: PlaceResult) => p.types?.includes(params.includedType!));
    }

    return { success: true, data: places.slice(0, params.maxResults || 20) };
  }

  async getPlaceDetails(placeId: string, maxPhotos?: number): Promise<{ success: boolean; data?: PlaceResult; error?: string }> {
    const url = new URL(`https://places.googleapis.com/v1/places/${placeId}`);

    const fields = [
      "displayName",
      "formattedAddress",
      "location",
      "rating",
      "userRatingCount",
      "priceLevel",
      "types",
      "nationalPhoneNumber",
      "internationalPhoneNumber",
      "websiteUri",
      "currentOpeningHours",
      "regularOpeningHours",
      "businessStatus",
      "editorialSummary",
      "reviews",
      "photos",
      "addressComponents",
    ].join(",");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": fields,
      },
    });

    const data = await response.json() as PlaceResult & { error?: { message: string } };

    if (data.error) {
      return { success: false, error: data.error.message };
    }

    let photos: Array<{ photoUri?: string; heightPx?: number; widthPx?: number }> = [];
    if (maxPhotos && data.photos) {
      photos = data.photos.slice(0, maxPhotos);
    }

    return {
      success: true,
      data: { ...data, photos },
    };
  }

  async getDirections(
    origin: string,
    destination: string,
    mode?: string,
    departureTime?: string,
    arrivalTime?: string
  ): Promise<{ success: boolean; data?: any[]; error?: string }> {
    const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
    url.searchParams.set("origin", origin);
    url.searchParams.set("destination", destination);
    url.searchParams.set("key", this.apiKey);
    
    if (mode) url.searchParams.set("mode", mode);
    if (departureTime) url.searchParams.set("departure_time", departureTime);
    if (arrivalTime) url.searchParams.set("arrival_time", arrivalTime);

    const response = await fetch(url.toString());
    const data = await response.json() as DirectionsResponse;

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return { success: false, error: data.error_message || data.status };
    }

    if (data.routes) {
      for (const route of data.routes) {
        delete route.overview_polyline;
        for (const leg of route.legs || []) {
          for (const step of leg.steps || []) {
            delete step.polyline;
            delete step.steps;
          }
        }
        delete route.legs;
      }
    }

    return { success: true, data: data.routes };
  }

  async calculateDistanceMatrix(
    origins: string[],
    destinations: string[],
    mode?: string,
    departureTime?: string
  ): Promise<{ success: boolean; data?: DistanceMatrixResponse; error?: string }> {
    const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
    url.searchParams.set("origins", origins.join("|"));
    url.searchParams.set("destinations", destinations.join("|"));
    url.searchParams.set("key", this.apiKey);
    
    if (mode) url.searchParams.set("mode", mode);
    if (departureTime) url.searchParams.set("departure_time", departureTime);

    const response = await fetch(url.toString());
    const data = await response.json() as DistanceMatrixResponse;

    if (data.status !== "OK") {
      return { success: false, error: data.error_message || data.status };
    }

    return { success: true, data };
  }

  async getElevation(locations: { latitude: number; longitude: number }[]): Promise<{ success: boolean; data?: any[]; error?: string }> {
    const url = new URL("https://maps.googleapis.com/maps/api/elevation/json");
    const locationsStr = locations.map(l => `${l.latitude},${l.longitude}`).join("|");
    url.searchParams.set("locations", locationsStr);
    url.searchParams.set("key", this.apiKey);

    const response = await fetch(url.toString());
    const data = await response.json() as ElevationResponse;

    if (data.status !== "OK") {
      return { success: false, error: data.error_message || data.status };
    }

    return { success: true, data: data.results };
  }

  async getTimezone(latitude: number, longitude: number, timestamp?: number): Promise<{ success: boolean; data?: TimezoneResponse; error?: string }> {
    const url = new URL("https://maps.googleapis.com/maps/api/timezone/json");
    url.searchParams.set("location", `${latitude},${longitude}`);
    url.searchParams.set("timestamp", String(timestamp ?? Math.floor(Date.now() / 1000)));
    url.searchParams.set("key", this.apiKey);

    const response = await fetch(url.toString());
    const data = await response.json() as TimezoneResponse;

    if (data.status !== "OK") {
      return { success: false, error: data.errorMessage || data.status };
    }

    return { success: true, data };
  }

  async getStaticMap(params: {
    center?: string;
    zoom?: number;
    size?: string;
    markers?: Array<{ location: string; color?: string; label?: string }>;
    path?: { points: string[]; color?: string; weight?: number };
  }): Promise<{ success: boolean; data?: { url: string; center?: string; zoom?: number; size?: string }; error?: string }> {
    const url = new URL("https://maps.googleapis.com/maps/api/staticmap");
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("size", params.size || "600x400");
    
    if (params.center) url.searchParams.set("center", params.center);
    if (params.zoom) url.searchParams.set("zoom", String(params.zoom));
    
    if (params.markers) {
      params.markers.forEach(marker => {
        let markerStr = "";
        if (marker.color) markerStr += `color:${marker.color}|`;
        if (marker.label) markerStr += `label:${marker.label}|`;
        markerStr += marker.location;
        url.searchParams.append("markers", markerStr);
      });
    }
    
    if (params.path) {
      let pathStr = "";
      if (params.path.color) pathStr += `color:${params.path.color}|`;
      if (params.path.weight) pathStr += `weight:${params.path.weight}|`;
      pathStr += params.path.points.join("|");
      url.searchParams.set("path", pathStr);
    }

    return { success: true, data: { url: url.toString() } };
  }

  async getWeather(
    latitude: number,
    longitude: number,
    type?: "current" | "forecast",
    forecastDays?: number,
    forecastHours?: number
  ): Promise<{ success: boolean; data?: WeatherResponse; error?: string }> {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    
    if (type === "current" || !type) {
      url.searchParams.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m");
    }
    
    if (type === "forecast" && forecastDays) {
      url.searchParams.set("forecast_days", String(forecastDays));
      url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max");
    }
    
    if (forecastHours) {
      url.searchParams.set("forecast_hours", String(forecastHours));
      url.searchParams.set("hourly", "temperature_2m,relative_humidity_2m,precipitation_probability,weather_code");
    }

    const response = await fetch(url.toString());
    const data = await response.json() as WeatherResponse;

    return { success: true, data };
  }

  private readonly keywordToType: Record<string, string> = {
    coffee: "coffee_shop",
    cafe: "cafe",
    "coffee shop": "coffee_shop",
    gas: "gas_station",
    petrol: "gas_station",
    "gas station": "gas_station",
    food: "restaurant",
    restaurant: "restaurant",
    pizza: "pizza_restaurant",
    burger: "hamburger_restaurant",
    pharmacy: "pharmacy",
    atm: "atm",
    hotel: "hotel",
    motel: "motel",
    hospital: "hospital",
    clinic: "clinic",
    bank: "bank",
    supermarket: "supermarket",
    grocery: "grocery_or_supermarket",
    shopping: "shopping_mall",
    mall: "shopping_mall",
    gym: "gym",
    fitness: "fitness_center",
    parking: "parking",
    "EV charger": "electric_vehicle_charging_station",
    ev: "electric_vehicle_charging_station",
  };

  private resolveKeywordType(keyword: string): string | undefined {
    return this.keywordToType[keyword.toLowerCase()];
  }

  async searchAlongRoute(params: {
    origin: string;
    destination: string;
    keyword: string;
    deviateTime?: number;
  }): Promise<{ success: boolean; data?: { route?: any; places?: PlaceResult[] }; error?: string }> {
    const routeResult = await this.getDirections(params.origin, params.destination);
    if (!routeResult.success || !routeResult.data?.[0]) {
      return { success: false, error: routeResult.error || "No route found" };
    }

    const route = routeResult.data[0];
    const points: { latitude: number; longitude: number }[] = [];
    
    if (route.bounds?.northeast && route.bounds?.southwest) {
      const { northeast, southwest } = route.bounds;
      const numPoints = 8;
      for (let i = 1; i < numPoints; i++) {
        const fraction = i / numPoints;
        points.push({
          latitude: southwest.latitude + (northeast.latitude - southwest.latitude) * fraction,
          longitude: southwest.longitude + (northeast.longitude - southwest.longitude) * fraction,
        });
      }
    }

    const resolvedType = this.resolveKeywordType(params.keyword);
    const searchRadius = params.deviateTime ? params.deviateTime * 100 : 5000;

    const allPlaces: PlaceResult[] = [];
    const seenIds = new Set<string>();

    for (const point of points) {
      const searchResult = resolvedType
        ? await this.searchNearby({
            center: { value: `${point.latitude},${point.longitude}`, isCoordinates: true },
            type: resolvedType,
            radius: searchRadius,
            maxResults: 10,
          })
        : await this.searchPlaces({
            query: params.keyword,
            locationBias: {
              latitude: point.latitude,
              longitude: point.longitude,
              radius: searchRadius,
            },
            maxResults: 10,
          });

      if (searchResult.success && searchResult.data) {
        for (const place of searchResult.data) {
          if (!seenIds.has(place.id)) {
            seenIds.add(place.id);
            allPlaces.push(place);
          }
        }
      }
    }

    return { success: true, data: { route, places: allPlaces.slice(0, 20) } };
  }

  async batchGeocode(addresses: string[]): Promise<{ success: boolean; data?: { total: number; succeeded: number; failed: number; results: any[] }; error?: string }> {
    const results = await Promise.all(
      addresses.map(async (address) => {
        try {
          const result = await this.geocode(address);
          return { address, ...result };
        } catch (error: any) {
          return { address, success: false, error: error.message };
        }
      })
    );

    const succeeded = results.filter((r) => r.success).length;
    return {
      success: true,
      data: {
        total: addresses.length,
        succeeded,
        failed: addresses.length - succeeded,
        results,
      },
    };
  }
}