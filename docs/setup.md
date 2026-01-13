# Setup & Configuration

This guide covers installation, authentication, and running Griphook.

## Prerequisites

- Node.js 18+
- npm or yarn
- Access to a STRATO deployment
- BlockApps account (for OAuth authentication)

## Installation

```bash
cd griphook
npm install
npm run build
```

## Configuration

Copy `.env.sample` to `.env` and configure your environment:

```bash
cp .env.sample .env
# Edit .env with your values
```

Griphook automatically loads the `.env` file on startup. You can also set environment variables manually if preferred.

## Authentication

Griphook uses a browser-based OAuth login flow to obtain tokens, then stores them locally for subsequent requests.

Configure OAuth credentials in `.env`:
```bash
OAUTH_CLIENT_ID=localhost
OAUTH_CLIENT_SECRET=your-client-secret
OPENID_DISCOVERY_URL=https://keycloak.blockapps.net/auth/realms/mercata/.well-known/openid-configuration
STRATO_API_BASE_URL=https://your-strato-instance/api
```

Then authenticate and start:
```bash
npm run login   # Opens browser for OAuth
npm start       # Start the server
```

Credentials are stored locally in `~/.griphook/credentials.json` and automatically refreshed.

Security note: credentials are not encrypted. See the repository's [SECURITY.md](../SECURITY.md).

**CLI Commands:**
| Command | Description |
|---------|-------------|
| `npm run login` | Authenticate via browser |
| `npm run logout` | Clear stored credentials |
| `npm run status` | Check authentication status |
| `griphook token` | Print Bearer token for MCP client configuration |

## Environment Variables

### OAuth Configuration

| Variable | Description | Example |
|----------|-------------|---------|
| `OAUTH_CLIENT_ID` | OAuth 2.0 client ID | `localhost` |
| `OAUTH_CLIENT_SECRET` | OAuth 2.0 client secret | `client-secret-value` |
| `OPENID_DISCOVERY_URL` | OpenID Connect discovery endpoint | `https://keycloak.blockapps.net/auth/realms/mercata/.well-known/openid-configuration` |

### STRATO Backend

| Variable | Description | Default |
|----------|-------------|---------|
| `STRATO_API_BASE_URL` | STRATO API base URL | `http://localhost:3001/api` |
| `STRATO_HTTP_TIMEOUT_MS` | HTTP request timeout in milliseconds | `15000` |

### Griphook Server

| Variable | Description | Default |
|----------|-------------|---------|
| `GRIPHOOK_HTTP_ENABLED` | Enable HTTP transport | `true` |
| `GRIPHOOK_HTTP_HOST` | HTTP server bind address | `127.0.0.1` |
| `GRIPHOOK_HTTP_PORT` | HTTP server port | `3005` |
| `GRIPHOOK_HTTP_PATH` | HTTP endpoint path | `/mcp` |
| `GRIPHOOK_HTTP_SSE_PATH` | Server-Sent Events path | `/mcp/events` |

### Hosted Mode (Multi-user Deployment)

| Variable | Description | Default |
|----------|-------------|---------|
| `GRIPHOOK_PUBLIC_URL` | Public URL for hosted mode (enables auth) | *unset* |
| `GRIPHOOK_HOSTED_CLIENT_ID` | OAuth client ID for hosted mode | `OAUTH_CLIENT_ID` |
| `GRIPHOOK_HOSTED_CLIENT_SECRET` | OAuth client secret for hosted mode | `OAUTH_CLIENT_SECRET` |

## Running Griphook

### Development Mode
Hot-reload during development:
```bash
npm run dev
```

### Production Build
Build and run compiled JavaScript:
```bash
npm run build
npm start
```

## Transports

Griphook supports two MCP transports simultaneously:

### Stdio Transport
The default transport for CLI-based MCP clients. When you launch Griphook as a subprocess, it communicates over stdin/stdout using the MCP protocol.

Used by:
- Claude Code
- Other MCP-aware CLI tools

### HTTP Streamable Transport
A REST-based transport for web integrations and remote connections.

- **Endpoint**: `POST http://{host}:{port}{path}`
- **SSE**: `GET http://{host}:{port}{ssePath}`

Default: `http://127.0.0.1:3005/mcp` with SSE at `/mcp/events`

To disable HTTP transport:
```bash
GRIPHOOK_HTTP_ENABLED=false npm start
```

## Example Configurations

### Claude Code Integration
Add to your project's `.mcp.json` or Claude Code settings:

```json
{
  "mcpServers": {
    "griphook": {
      "command": "node",
      "args": ["/absolute/path/to/griphook/dist/cli.js", "serve"],
      "env": {
        "OAUTH_CLIENT_ID": "your-client-id",
        "OAUTH_CLIENT_SECRET": "your-client-secret",
        "OPENID_DISCOVERY_URL": "https://keycloak.blockapps.net/auth/realms/mercata/.well-known/openid-configuration",
        "STRATO_API_BASE_URL": "https://your-strato-instance/api"
      }
    }
  }
}
```

Note: Run `npm run login` in the griphook directory first to authenticate.

## Authentication Flow

### Browser Mode
1. User runs `npm run login`
2. Griphook starts local callback server on port 8085
3. Browser opens to Keycloak login page
4. User authenticates in browser
5. Keycloak redirects to local callback with auth code
6. Griphook exchanges code for tokens using PKCE
7. Tokens saved to `~/.griphook/credentials.json`
8. Subsequent API calls use stored tokens (auto-refreshed)

## Troubleshooting

### Browser Login Issues
```
Error: OPENID_DISCOVERY_URL environment variable is required
```
Set the required OAuth environment variables before running login.

### OAuth Token Failure
```
Error: Failed to acquire access token
```
- Verify credentials are correct
- Check `OPENID_DISCOVERY_URL` is accessible
- Ensure client ID/secret match the OAuth provider configuration

### 403 Forbidden Errors
```
Request failed with status code 403
```
- Token may have expired - run `npm run login` again
- Verify `STRATO_API_BASE_URL` matches the realm used for authentication
- Check that the OAuth client is authorized for the target STRATO instance

### Connection Refused
```
Error: connect ECONNREFUSED 127.0.0.1:3001
```
- Verify `STRATO_API_BASE_URL` points to a running STRATO instance
- Check network connectivity and firewall rules

### HTTP Transport Not Starting
If HTTP transport fails but stdio works:
- Check if the port is already in use
- Verify `GRIPHOOK_HTTP_HOST` is a valid bind address
- Review logs for specific error messages

## Hosted Mode (Multi-user Deployment)

Hosted mode allows you to run a single Griphook instance that multiple users can connect to with their own STRATO credentials.

### Enabling Hosted Mode

Set `GRIPHOOK_PUBLIC_URL` to enable hosted mode:

```bash
GRIPHOOK_PUBLIC_URL=https://griphook.strato.nexus npm start
```

In hosted mode:
- All MCP endpoints require Bearer token authentication
- The server exposes `/.well-known/oauth-protected-resource` for RFC 9728 OAuth discovery
- MCP clients with OAuth support can authenticate automatically

### OAuth Discovery (RFC 9728)

When a client connects without a token, the server returns:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://griphook.strato.nexus/.well-known/oauth-protected-resource"
```

The metadata endpoint returns:
```json
{
  "resource": "https://griphook.strato.nexus/mcp",
  "authorization_servers": ["https://keycloak.blockapps.net/auth/realms/mercata"],
  "scopes_supported": ["openid", "email", "profile"],
  "bearer_methods_supported": ["header"]
}
```

Clients that support MCP OAuth (VS Code, Windsurf, OpenCode) will handle this automatically.

### Connecting to a Hosted Server

#### Option 1: OAuth (Recommended)

For clients with OAuth support, just configure the URL:

```json
{
  "mcpServers": {
    "griphook": {
      "url": "https://griphook.strato.nexus/mcp"
    }
  }
}
```

The client will handle authentication automatically via browser.

#### Option 2: Bearer Token (Fallback)

For clients without OAuth support (Cursor, Cline), use a Bearer token:

1. Install Griphook locally and login:
   ```bash
   npm install -g griphook
   griphook login
   ```

2. Get your token:
   ```bash
   griphook token
   ```

3. Configure your MCP client with the token:
   ```json
   {
     "mcpServers": {
       "griphook": {
         "url": "https://griphook.strato.nexus/mcp",
         "headers": {
           "Authorization": "Bearer YOUR_TOKEN_HERE"
         }
       }
     }
   }
   ```

Note: Tokens expire. Run `griphook token` again to get a fresh token when needed.

### Keycloak Configuration for Hosted Mode

For production hosted deployments, you may want a separate OAuth client:

1. Create a new client in Keycloak (e.g., `griphook-hosted`)
2. Set valid redirect URIs for your hosted domain
3. Configure the client credentials in your environment:
   ```bash
   GRIPHOOK_HOSTED_CLIENT_ID=griphook-hosted
   GRIPHOOK_HOSTED_CLIENT_SECRET=your-secret
   ```
