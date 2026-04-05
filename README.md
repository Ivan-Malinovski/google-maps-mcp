# Google Maps MCP Server on Cloudflare Workers

A Model Context Protocol (MCP) server for Google Maps that runs on Cloudflare Workers with GitHub OAuth authentication.

## Features

- **17 Google Maps tools** - geocoding, directions, places, weather, and more
- **GitHub OAuth** - Secure authentication with username allowlist
- **Cloudflare Workers** - Serverless, global deployment
- **Claude.ai compatible** - Works with Claude.ai, Claude Desktop, and Claude mobile

## Tools Available

| Tool | Description |
|------|-------------|
| `maps_geocode` | Convert address to coordinates |
| `maps_reverse_geocode` | Convert coordinates to address |
| `maps_search_nearby` | Search places near a location |
| `maps_search_places` | Free-text place search |
| `maps_place_details` | Get details for a place |
| `maps_directions` | Step-by-step directions |
| `maps_distance_matrix` | Calculate distances between points |
| `maps_weather` | Get weather data |
| `maps_static_map` | Generate static map images |
| `maps_batch_geocode` | Geocode multiple addresses |
| `maps_search_along_route` | Find places along a route |
| `maps_explore_area` | Explore places around a location |
| `maps_plan_route` | Plan multi-stop routes |
| `maps_compare_places` | Compare multiple places |
| `maps_local_rank_tracker` | Track local search rankings |

## Prerequisites

1. A Cloudflare account (free tier works)
2. A GitHub account for OAuth
3. A Google Maps API key with the following APIs enabled:
   - Geocoding API
   - Places API (New)
   - Directions API
   - Distance Matrix API
   - Static Maps API

Get your API key from [Google Cloud Console](https://console.cloud.google.com/apis/credentials).

## Setup

### 1. Create GitHub OAuth App

Go to [github.com/settings/applications/new](https://github.com/settings/applications/new):

| Field | Value |
|-------|-------|
| Application name | `Google Maps MCP` |
| Homepage URL | `https://your-worker-name.your-subdomain.workers.dev` |
| Authorization callback URL | `https://your-worker-name.your-subdomain.workers.dev/callback` |

Save the Client ID and Client Secret.

### 2. Clone and Install

```bash
git clone https://github.com/Ivan-Malinovski/google-maps-mcp.git
cd google-maps-mcp
npm install
```

### 3. Set Allowed Usernames

Edit `src/github-handler.ts`:

```typescript
const ALLOWED_USERNAMES = new Set<string>([
  "your-github-username",  // <-- CHANGE THIS
]);
```

Only these GitHub users can access the MCP.

### 4. Deploy to Cloudflare Workers

```bash
# Create KV namespace
npx wrangler kv namespace create "OAUTH_KV"
# Copy the ID from output

# Update wrangler.jsonc with the KV namespace ID
# "id": "your_kv_namespace_id_here"

# Set secrets
npx wrangler secret put GITHUB_CLIENT_ID --name google-maps-mcp
npx wrangler secret put GITHUB_CLIENT_SECRET --name google-maps-mcp
npx wrangler secret put COOKIE_ENCRYPTION_KEY --name google-maps-mcp
npx wrangler secret put GOOGLE_MAPS_API_KEY --name google-maps-mcp

# Deploy
npm run deploy
```

### 5. Connect Claude

#### Claude.ai (web)

1. Go to Settings → Connectors → Add custom connector
2. Enter your worker URL: `https://your-worker-name.your-subdomain.workers.dev/mcp`
3. Complete GitHub OAuth

The connector will also appear in Claude mobile app automatically.

#### Claude Desktop

Add to `claude_desktop_config.json`:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "google-maps": {
      "url": "https://your-worker-name.your-subdomain.workers.dev/mcp",
      "auth": {
        "type": "oauth",
        "clientId": "google-maps-desktop"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth App client secret |
| `COOKIE_ENCRYPTION_KEY` | Yes | 64-char hex for session encryption |
| `GOOGLE_MAPS_API_KEY` | Yes | Your Google Maps API key |

## API Costs

This MCP uses Google Maps APIs. Be aware of costs:
- Geocoding API: $5 per 1000 requests
- Places API (New): $7 per 1000 requests
- Directions API: $5 per 1000 requests
- Distance Matrix API: $5 per 1000 requests
- Elevation API: $5 per 1000 requests

See [Google Maps Pricing](https://mapsplatform.google.com/pricing/) for details.

## How It Works

1. Client connects and initiates OAuth flow
2. User authenticates with GitHub
3. Worker checks if GitHub username is in allowlist
4. If authorized, all Google Maps tools are available
5. API calls use your server-side Google Maps API key

## Security

- **Google Maps API key** stored as Cloudflare Worker secret, never exposed to clients
- **GitHub OAuth** handled by `workers-oauth-provider` (OAuth 2.1 + PKCE)
- **Username allowlist** restricts access to authorized users only
- **All tools are read-only** - no destructive operations

## Troubleshooting

### "Access Denied" after OAuth

Your GitHub username is not in the allowlist. Update `src/github-handler.ts` and redeploy.

### Tools not appearing

1. Complete OAuth flow in browser
2. Restart Claude
3. Check logs: `npx wrangler tail`

### Google Maps API errors

1. Verify APIs are enabled in Google Cloud Console
2. Check API key has correct permissions
3. Verify billing is enabled for the Google Cloud project

## License

MIT