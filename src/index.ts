import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import { GoogleMapsService } from "./google-maps-service";
import { toUserMessage } from "./errors";

export interface Env {
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectStub<GoogleMapsMCP>;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  GOOGLE_MAPS_API_KEY: string;
}

type Props = {
  login: string;
  name: string;
  email: string;
  accessToken: string;
};

const ALLOWED_USERNAMES = new Set<string>([
  "your-github-username", // <-- CHANGE THIS to your GitHub username
]);

// Tool annotations - all tools are read-only
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export class GoogleMapsMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "Google Maps MCP",
    version: "1.0.0",
  });

  async init() {
    const maps = new GoogleMapsService(this.env.GOOGLE_MAPS_API_KEY);

    // Check allowlist helper
    const checkAccess = () => {
      if (!ALLOWED_USERNAMES.has(this.props!.login)) {
        return {
          error: true,
          message: "Access denied. Your GitHub username is not authorized.",
        };
      }
      return null;
    };

    this.server.registerResource(
      "favorite-places",
      new ResourceTemplate("maps://places/{placeName}", {
        list: async () => {
          const accessError = checkAccess();
          if (accessError) throw new Error(accessError.message);
          return {
            resources: [
              { uri: "maps://places/Home", name: "Home", description: "Your home location" },
              { uri: "maps://places/Work", name: "Work", description: "Your workplace" },
            ]
          };
        }
      }),
      {
        title: "Favorite Places",
        description: "Quick access to your saved locations",
        mimeType: "application/json"
      },
      async (uri, { placeName }) => {
        const accessError = checkAccess();
        if (accessError) throw new Error(accessError.message);
        const name = Array.isArray(placeName) ? placeName[0] : placeName;
        const favorites: Record<string, string> = {
          "Home": "Your home address",
          "Work": "Your work address",
        };
        const address = favorites[decodeURIComponent(name)];
        if (!address) throw new Error(`Place ${name} not found`);
        const result = await maps.geocode(address);
        return {
          contents: [{
            uri: `maps://places/${encodeURIComponent(name)}`,
            mimeType: "application/json",
            text: JSON.stringify(result)
          }]
        };
      }
    );

    this.server.registerResource(
      "maps-info",
      "maps://info",
      {
        title: "Google Maps MCP Info",
        description: "Information about available tools and resources",
        mimeType: "application/json"
      },
      async (uri) => {
        return {
          contents: [{
            uri: "maps://info",
            mimeType: "application/json",
            text: JSON.stringify({
              name: "Google Maps MCP",
              version: "1.0.0",
              tools: [
                "maps_geocode", "maps_reverse_geocode", "maps_search_nearby",
                "maps_search_places", "maps_place_details", "maps_directions",
                "maps_distance_matrix", "maps_weather", "maps_static_map",
                "maps_batch_geocode", "maps_search_along_route", "maps_explore_area",
                "maps_plan_route", "maps_compare_places", "maps_local_rank_tracker"
              ],
              resources: ["maps://places/{name}", "maps://info"],
              prompts: ["commute-route", "weather-at-location", "nearby-places"]
            })
          }]
        };
      }
    );

    this.server.registerPrompt(
      "commute-route",
      {
        title: "Commute Route",
        description: "Get directions for your daily commute",
        argsSchema: {
          home: z.string().describe("Your home address or place name"),
          work: z.string().describe("Your work address or place name"),
          mode: z.enum(["driving", "walking", "bicycling", "transit"]).describe("Travel mode").optional(),
        },
      },
      async (args: { home: string; work: string; mode?: "driving" | "walking" | "bicycling" | "transit" }) => {
        const accessError = checkAccess();
        if (accessError) return { messages: [{ role: "user", content: { type: "text", text: accessError.message } }] };
        try {
          const result = await maps.getDirections(args.home, args.work, args.mode || "driving");
          if (!result.success) {
            return { messages: [{ role: "user", content: { type: "text", text: toUserMessage(result.error, "Failed to get directions") } }] };
          }
          const route = result.data?.[0];
          if (!route) {
            return { messages: [{ role: "user", content: { type: "text", text: "No route found" } }] };
          }
          const leg = route.legs?.[0];
          return {
            description: "Commute directions",
            messages: [{
              role: "user",
              content: {
                type: "text",
                text: `Commute from ${args.home} to ${args.work}:\n` +
                  `Distance: ${leg?.distance?.text || "unknown"}\n` +
                  `Duration: ${leg?.duration?.text || "unknown"}\n` +
                  (route.waypointOrder ? `Waypoints: ${route.waypointOrder.length} stops` : "")
              }
            }]
          };
        } catch (e: any) {
          return { messages: [{ role: "user", content: { type: "text", text: `Error: ${e.message}` } }] };
        }
      }
    );

    this.server.registerPrompt(
      "weather-at-location",
      {
        title: "Weather at Location",
        description: "Get current weather or forecast for a location",
        argsSchema: {
          location: z.string().describe("Address or place name"),
          type: z.enum(["current", "forecast"]).describe("Weather type").optional(),
          forecastDays: z.number().describe("Forecast days (1-16)").optional(),
        },
      },
      async (args: { location: string; type?: "current" | "forecast"; forecastDays?: number }) => {
        const accessError = checkAccess();
        if (accessError) return { messages: [{ role: "user", content: { type: "text", text: accessError.message } }] };
        try {
          const geo = await maps.geocode(args.location);
          if (!geo.success || !geo.data?.[0]) {
            return { messages: [{ role: "user", content: { type: "text", text: toUserMessage(geo.error, "Location not found") } }] };
          }
          const { lat, lng } = geo.data[0].geometry.location;
          const weather = await maps.getWeather(lat, lng, args.type, args.forecastDays);
          if (!weather.success) {
            return { messages: [{ role: "user", content: { type: "text", text: toUserMessage(weather.error, "Weather unavailable") } }] };
          }
          const w = weather.data;
          if (!w) {
            return { messages: [{ role: "user", content: { type: "text", text: "Weather data unavailable" } }] };
          }
          let text = `Weather at ${args.location}:\n`;
          if (w.current) {
            text += `Current: ${w.current.temperature_2m}°C, ${w.current.weather_code || "unknown"}\n`;
            text += `Humidity: ${w.current.relative_humidity_2m}%, Wind: ${w.current.wind_speed_10m} km/h`;
          }
          if (w.daily && args.type === "forecast") {
            text += `\nForecast: ${w.daily.temperature_2m_max?.join("°/")}°C`;
          }
          return { description: "Weather information", messages: [{ role: "user", content: { type: "text", text } }] };
        } catch (e: any) {
          return { messages: [{ role: "user", content: { type: "text", text: `Error: ${e.message}` } }] };
        }
      }
    );

    this.server.registerPrompt(
      "nearby-places",
      {
        title: "Find Nearby Places",
        description: "Search for places near a location",
        argsSchema: {
          location: z.string().describe("Center location (address or coordinates)"),
          type: z.string().describe("Place type (e.g., restaurant, cafe, hotel)").optional(),
          keyword: z.string().describe("Search keyword").optional(),
          radius: z.number().describe("Search radius in meters").optional(),
          maxResults: z.number().describe("Maximum results").optional(),
        },
      },
      async (args: { location: string; type?: string; keyword?: string; radius?: number; maxResults?: number }) => {
        const accessError = checkAccess();
        if (accessError) return { messages: [{ role: "user", content: { type: "text", text: accessError.message } }] };
        try {
          const result = await maps.searchNearby({
            center: { value: args.location },
            type: args.type,
            keyword: args.keyword,
            radius: args.radius,
            maxResults: args.maxResults || 10,
          });
          if (!result.success) {
            return { messages: [{ role: "user", content: { type: "text", text: toUserMessage(result.error, "Search failed") } }] };
          }
          const places = result.data || [];
          if (places.length === 0) {
            return { messages: [{ role: "user", content: { type: "text", text: `No places found near ${args.location}` } }] };
          }
          const list = places.map((p, i) => 
            `${i + 1}. ${p.displayName?.text || "Unknown"}` +
            (p.rating ? ` (${p.rating}★, ${p.userRatingCount} reviews)` : "") +
            (p.currentOpeningHours?.openNow !== undefined ? ` - ${p.currentOpeningHours.openNow ? "Open now" : "Closed"}` : "")
          ).join("\n");
          return {
            description: "Nearby places",
            messages: [{ role: "user", content: { type: "text", text: `Places near ${args.location}:\n${list}` } }]
          };
        } catch (e: any) {
          return { messages: [{ role: "user", content: { type: "text", text: `Error: ${e.message}` } }] };
        }
      }
    );

    // 1. maps_geocode
    this.server.tool(
      "maps_geocode",
      "Convert an address or place name into GPS coordinates (latitude/longitude). Use when you need precise coordinates for a location.",
      {
        address: z.string().describe("Address or place name to convert to coordinates"),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        const result = await maps.geocode(params.address);
        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toUserMessage(result.error, "Failed to geocode address") }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // 2. maps_reverse_geocode
    this.server.tool(
      "maps_reverse_geocode",
      "Convert GPS coordinates into a street address or place name.",
      {
        latitude: z.number().describe("Latitude coordinate"),
        longitude: z.number().describe("Longitude coordinate"),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        const result = await maps.reverseGeocode(params.latitude, params.longitude);
        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toUserMessage(result.error, "Failed to reverse geocode") }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // 3. maps_search_nearby
    this.server.tool(
      "maps_search_nearby",
      "Find places near a location using typed/categorical search (restaurants, cafes, hotels, etc.). Use this for 'restaurants near me' queries. Supports radius, rating filters, and open-now filters.",
      {
        center: z.object({
          value: z.string().describe("Address or 'latitude,longitude' coordinates"),
          isCoordinates: z.boolean().describe("True if center.value is coordinates").optional(),
        }),
        radius: z.number().describe("Search radius in meters (default 1000)").optional(),
        keyword: z.string().describe("Search keyword to filter results (e.g., 'pizza', 'coffee')").optional(),
        type: z.string().describe("Place type from Google Places API (e.g., 'restaurant', 'cafe', 'hotel', 'gas_station')").optional(),
        minRating: z.number().describe("Minimum rating filter (e.g., 4.0 for 4+ stars)").optional(),
        openNow: z.boolean().describe("Filter for places currently open").optional(),
        maxResults: z.number().describe("Maximum number of results").optional(),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        const result = await maps.searchNearby(params);
        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toUserMessage(result.error, "Failed to search nearby") }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // 4. maps_search_places
    this.server.tool(
      "maps_search_places",
      "Free-text natural language place search. Use this for 'best sushi restaurant in Tokyo' or 'coffee shop near Central Park' queries. Matches against place names, types, and reviews.",
      {
        query: z.string().describe("Natural language search query (e.g., 'ramen in Tokyo', 'coffee shop Manhattan')"),
        locationBias: z.object({
          latitude: z.number(),
          longitude: z.number(),
          radius: z.number().optional(),
        }).optional(),
        openNow: z.boolean().describe("Filter for currently open places").optional(),
        minRating: z.number().describe("Minimum rating filter").optional(),
        includedType: z.string().describe("Place type to include").optional(),
        maxResults: z.number().describe("Maximum number of results").optional(),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        const result = await maps.searchPlaces(params);
        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toUserMessage(result.error, "Failed to search places") }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // 5. maps_place_details
    this.server.tool(
      "maps_place_details",
      "Get full details for a place by its place_id — reviews, phone, website, hours.",
      {
        placeId: z.string().describe("Google Place ID"),
        maxPhotos: z.number().describe("Maximum number of photos to return").optional(),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        const result = await maps.getPlaceDetails(params.placeId, params.maxPhotos);
        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toUserMessage(result.error, "Failed to get place details") }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // 6. maps_directions
    this.server.tool(
      "maps_directions",
      "Get step-by-step navigation between two points with route details.",
      {
        origin: z.string().describe("Starting point (address or coordinates)"),
        destination: z.string().describe("Ending point (address or coordinates)"),
        mode: z.enum(["driving", "walking", "bicycling", "transit"]).describe("Travel mode").optional(),
        departureTime: z.string().describe("Departure time (ISO string or 'now')").optional(),
        arrivalTime: z.string().describe("Arrival time (ISO string)").optional(),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        const result = await maps.getDirections(
          params.origin,
          params.destination,
          params.mode,
          params.departureTime,
          params.arrivalTime
        );
        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toUserMessage(result.error, "Failed to get directions") }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // 7. maps_distance_matrix
    this.server.tool(
      "maps_distance_matrix",
      "Calculate travel distances and times between multiple origins and destinations.",
      {
        origins: z.array(z.string()).describe("Array of origin locations"),
        destinations: z.array(z.string()).describe("Array of destination locations"),
        mode: z.enum(["driving", "walking", "bicycling", "transit"]).describe("Travel mode").optional(),
        departureTime: z.string().describe("Departure time").optional(),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        const result = await maps.calculateDistanceMatrix(
          params.origins,
          params.destinations,
          params.mode,
          params.departureTime
        );
        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toUserMessage(result.error, "Failed to calculate distance matrix") }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // 10. maps_weather
    this.server.tool(
      "maps_weather",
      "Get current weather conditions or forecast — temperature, humidity, wind, precipitation.",
      {
        latitude: z.number().describe("Latitude coordinate"),
        longitude: z.number().describe("Longitude coordinate"),
        type: z.enum(["current", "forecast"]).describe("Weather data type").optional(),
        forecastDays: z.number().describe("Number of forecast days (1-16)").optional(),
        forecastHours: z.number().describe("Number of forecast hours").optional(),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        const result = await maps.getWeather(
          params.latitude,
          params.longitude,
          params.type,
          params.forecastDays,
          params.forecastHours
        );
        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toUserMessage(result.error, "Failed to get weather") }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // 11. maps_static_map
    this.server.tool(
      "maps_static_map",
      "Generate a map image with markers, paths, or routes — returned as URL.",
      {
        center: z.string().describe("Center location (address or coordinates)").optional(),
        zoom: z.number().describe("Zoom level (1-20)").optional(),
        size: z.string().describe("Image size (e.g., '600x400')").optional(),
        markers: z.array(z.object({
          location: z.string().describe("Marker location"),
          color: z.string().describe("Marker color").optional(),
          label: z.string().describe("Marker label (single char)").optional(),
        })).describe("Map markers").optional(),
        path: z.object({
          points: z.array(z.string()).describe("Path points"),
          color: z.string().describe("Path color").optional(),
          weight: z.number().describe("Path line weight").optional(),
        }).describe("Path to draw").optional(),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        const result = await maps.getStaticMap(params);
        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toUserMessage(result.error, "Failed to generate static map") }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // 12. maps_batch_geocode
    this.server.tool(
      "maps_batch_geocode",
      "Geocode multiple addresses in one call — returns coordinates for each.",
      {
        addresses: z.array(z.string()).describe("Array of addresses to geocode (max 50)"),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        if (params.addresses.length > 50) {
          return {
            content: [{ type: "text", text: "Maximum 50 addresses allowed per batch" }],
            isError: true,
          };
        }
        const result = await maps.batchGeocode(params.addresses);
        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toUserMessage(result.error, "Failed to batch geocode") }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // 13. maps_search_along_route
    this.server.tool(
      "maps_search_along_route",
      "Search for places along a route between two points — ranked by proximity.",
      {
        origin: z.string().describe("Starting point"),
        destination: z.string().describe("Ending point"),
        keyword: z.string().describe("Search keyword (e.g., 'gas station', 'coffee')"),
        deviateTime: z.number().describe("Maximum deviation time in minutes").optional(),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        const result = await maps.searchAlongRoute(params);
        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toUserMessage(result.error, "Failed to search along route") }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // 14. maps_explore_area
    this.server.tool(
      "maps_explore_area",
      "Explore what's around a location — searches multiple place types in one call.",
      {
        center: z.object({
          value: z.string().describe("Address or 'latitude,longitude' coordinates"),
          isCoordinates: z.boolean().describe("True if center.value is coordinates").optional(),
        }),
        radius: z.number().describe("Search radius in meters").optional(),
        placeTypes: z.array(z.string()).describe("Types of places to search (e.g., ['restaurant', 'cafe', 'hotel'])").optional(),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        
        const defaultTypes = ["restaurant", "cafe", "bar", "hotel", "tourist_attraction"];
        const types = params.placeTypes || defaultTypes;
        
        const results: Record<string, any> = {};
        
        for (const type of types) {
          const searchResult = await maps.searchNearby({
            center: params.center,
            radius: params.radius || 1000,
            type,
            maxResults: 5,
          });
          results[type] = searchResult.success ? searchResult.data : [];
        }
        
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, data: results }, null, 2) }],
        };
      }
    );

    // 15. maps_plan_route
    this.server.tool(
      "maps_plan_route",
      "Plan an optimized multi-stop route — uses Routes API waypoint optimization.",
      {
        origin: z.string().describe("Starting point"),
        destinations: z.array(z.string()).describe("Array of stops (max 25)"),
        mode: z.enum(["driving", "walking", "bicycling", "transit"]).describe("Travel mode").optional(),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        
        if (params.destinations.length > 25) {
          return {
            content: [{ type: "text", text: "Maximum 25 stops allowed" }],
            isError: true,
          };
        }
        
        const waypoints = params.destinations.join("|");
        const result = await maps.getDirections(params.origin, waypoints, params.mode);
        
        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: toUserMessage(result.error, "Failed to plan route") }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // 16. maps_compare_places
    this.server.tool(
      "maps_compare_places",
      "Compare places side-by-side — searches and gets details in one call.",
      {
        queries: z.array(z.string()).describe("Array of place queries to compare (max 5)"),
        locationBias: z.object({
          latitude: z.number(),
          longitude: z.number(),
          radius: z.number().optional(),
        }).optional(),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        
        if (params.queries.length > 5) {
          return {
            content: [{ type: "text", text: "Maximum 5 queries allowed for comparison" }],
            isError: true,
          };
        }
        
        const results: any[] = [];
        
        for (const query of params.queries) {
          const searchResult = await maps.searchPlaces({
            query,
            locationBias: params.locationBias,
            maxResults: 1,
          });
          
          if (searchResult.success && searchResult.data?.[0]) {
            const place = searchResult.data[0];
            const details = await maps.getPlaceDetails(place.id);
            results.push({
              query,
              place: {
                ...place,
                details: details.success ? details.data : null,
              },
            });
          } else {
            results.push({ query, place: null });
          }
        }
        
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, data: results }, null, 2) }],
        };
      }
    );

    // 17. maps_local_rank_tracker
    this.server.tool(
      "maps_local_rank_tracker",
      "Track a business's local search ranking across a geographic grid — like LocalFalcon.",
      {
        businessName: z.string().describe("Business name to search for"),
        keywords: z.array(z.string()).describe("Keywords to search (max 3)"),
        center: z.object({
          latitude: z.number(),
          longitude: z.number(),
        }).describe("Grid center point"),
        gridSize: z.number().describe("Grid size (e.g., 3 for 3x3)").optional(),
        radius: z.number().describe("Grid radius in meters").optional(),
      },
      TOOL_ANNOTATIONS,
      async (params) => {
        const accessError = checkAccess();
        if (accessError) {
          return { content: [{ type: "text", text: accessError.message }], isError: true };
        }
        
        const keywords = params.keywords.slice(0, 3);
        const gridSize = params.gridSize || 3;
        const radius = params.radius || 1000;
        
        // Generate grid points
        const points: { lat: number; lng: number; latOffset: number; lngOffset: number }[] = [];
        const step = radius / 1000; // Convert to degrees approximately
        
        for (let i = -Math.floor(gridSize / 2); i <= Math.floor(gridSize / 2); i++) {
          for (let j = -Math.floor(gridSize / 2); j <= Math.floor(gridSize / 2); j++) {
            points.push({
              lat: params.center.latitude + (i * step * 0.009), // ~1km per 0.009 degrees
              lng: params.center.longitude + (j * step * 0.009),
              latOffset: i,
              lngOffset: j,
            });
          }
        }
        
        const results: Record<string, any>[] = [];
        
        for (const keyword of keywords) {
          const ranks: Record<string, any> = { keyword, results: [] };
          
          for (const point of points) {
            const searchResult = await maps.searchPlaces({
              query: keyword,
              locationBias: { latitude: point.lat, longitude: point.lng, radius: 500 },
              maxResults: 20,
            });
            
            if (searchResult.success && searchResult.data) {
              const rank = searchResult.data.findIndex((p: any) => 
                p.displayName?.text?.toLowerCase().includes(params.businessName.toLowerCase())
              ) + 1;
              
              ranks.results.push({
                point: `${point.latOffset},${point.lngOffset}`,
                rank: rank || "Not found",
                totalResults: searchResult.data.length,
              });
            }
          }
          
          results.push(ranks);
        }
        
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, data: results }, null, 2) }],
        };
      }
    );
  }
}

export default new OAuthProvider({
  apiHandler: GoogleMapsMCP.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GitHubHandler as any,
  tokenEndpoint: "/token",
});