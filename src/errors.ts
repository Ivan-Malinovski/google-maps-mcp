export class MapsError extends Error {
  constructor(
    message: string,
    public userMessage: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = "MapsError";
  }
}

export const MapsErrorMessages: Record<string, string> = {
  "REQUEST_DENIED": "API request was denied. Check your Google Maps API key.",
  "INVALID_REQUEST": "Invalid request parameters. Please check your input.",
  "OVER_QUERY_LIMIT": "API quota exceeded. Try again later.",
  "NOT_FOUND": "Location or place not found.",
  "ZERO_RESULTS": "No results found for your search.",
  "UNKNOWN_ERROR": "Google Maps API error. Try again later.",
  "NETWORK_ERROR": "Network error. Check your connection.",
  "GEOCODE_ERROR": "Failed to geocode address. Try a more specific address.",
};

export function toUserMessage(error: any, defaultMsg: string): string {
  if (error instanceof MapsError) return error.userMessage;
  if (typeof error === "string") {
    for (const [key, msg] of Object.entries(MapsErrorMessages)) {
      if (error.includes(key)) return msg;
    }
  }
  if (error.message) {
    for (const [key, msg] of Object.entries(MapsErrorMessages)) {
      if (error.message.includes(key)) return msg;
    }
  }
  return defaultMsg;
}
