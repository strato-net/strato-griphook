import "dotenv/config";
import { createRequire } from "module";
import { randomBytes, createHash } from "crypto";
import type { Request, Response, NextFunction, Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, GriphookConfig } from "./config.js";
import { GriphookClient } from "./client.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import axios from "axios";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/**
 * RFC 9728 Protected Resource Metadata
 * https://datatracker.ietf.org/doc/html/rfc9728
 */
function getProtectedResourceMetadata(config: GriphookConfig) {
  if (!config.hosted || !config.oauth) return null;

  // Extract authorization server URL from OpenID discovery URL
  // e.g., https://keycloak.blockapps.net/auth/realms/mercata/.well-known/openid-configuration
  // -> https://keycloak.blockapps.net/auth/realms/mercata
  const authServer = config.oauth.openIdDiscoveryUrl.replace("/.well-known/openid-configuration", "");

  return {
    resource: `${config.hosted.publicUrl}${config.http.path}`,
    authorization_servers: [authServer],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/strato-net/strato-griphook",
  };
}

/**
 * Build WWW-Authenticate header value for 401 responses
 */
function buildWwwAuthenticateHeader(config: GriphookConfig): string {
  const metadataUrl = `${config.hosted!.publicUrl}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${metadataUrl}"`;
}

/**
 * In-memory store for PKCE state (short-lived, cleared after use)
 */
const pendingLogins = new Map<string, { verifier: string; expiresAt: number }>();

/**
 * In-memory cache for access tokens (keyed by refresh token hash)
 * Stores: { accessToken, expiresAt }
 */
const accessTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

/** Buffer time before expiry to trigger refresh (1 minute) */
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

/**
 * Generate PKCE code verifier and challenge
 */
function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Clean up expired pending logins
 */
function cleanupPendingLogins() {
  const now = Date.now();
  for (const [state, data] of pendingLogins) {
    if (now > data.expiresAt) {
      pendingLogins.delete(state);
    }
  }
}

/**
 * HTML page templates for login flow
 */
const loginPageHtml = (error?: string) => `
<!DOCTYPE html>
<html>
<head>
  <title>Griphook Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 700px; margin: 40px auto; padding: 20px; background: #fafafa; }
    .ascii-art { font-family: monospace; font-size: 8px; line-height: 1.1; white-space: pre; color: #0066cc; margin-bottom: 30px; overflow-x: auto; }
    @media (min-width: 600px) { .ascii-art { font-size: 10px; } }
    h1 { color: #333; margin-top: 0; }
    .btn { display: inline-block; padding: 14px 28px; background: #0066cc; color: white; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 500; }
    .btn:hover { background: #0052a3; }
    .error { background: #fee; border: 1px solid #c00; padding: 12px; border-radius: 6px; margin-bottom: 20px; color: #900; }
    p { line-height: 1.6; color: #555; }
    .card { background: white; border-radius: 8px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .subtitle { color: #666; font-size: 14px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="ascii-art">███████╗████████╗██████╗  █████╗ ████████╗ ██████╗
██╔════╝╚══██╔══╝██╔══██╗██╔══██╗╚══██╔══╝██╔═══██╗
███████╗   ██║   ██████╔╝███████║   ██║   ██║   ██║
╚════██║   ██║   ██╔══██╗██╔══██║   ██║   ██║   ██║
███████║   ██║   ██║  ██║██║  ██║   ██║   ╚██████╔╝
╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝

 ██████╗ ██████╗ ██╗██████╗ ██╗  ██╗ ██████╗  ██████╗ ██╗  ██╗
██╔════╝ ██╔══██╗██║██╔══██╗██║  ██║██╔═══██╗██╔═══██╗██║ ██╔╝
██║  ███╗██████╔╝██║██████╔╝███████║██║   ██║██║   ██║█████╔╝
██║   ██║██╔══██╗██║██╔═══╝ ██╔══██║██║   ██║██║   ██║██╔═██╗
╚██████╔╝██║  ██║██║██║     ██║  ██║╚██████╔╝╚██████╔╝██║  ██╗
 ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝     ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝</div>

  <div class="card">
    <h1>Login</h1>
    <p class="subtitle">MCP Server for STRATO Blockchain</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <p>Sign in to get a token for use with AI coding assistants like Claude Code, Cursor, Cline, Windsurf, and others.</p>
    <p><a href="/login/start" class="btn">Sign in with STRATO</a></p>
  </div>
</body>
</html>
`;

const tokenPageHtml = (refreshToken: string, expiresInDays: number, publicUrl: string) => `
<!DOCTYPE html>
<html>
<head>
  <title>Griphook - Your Token</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; background: #fafafa; }
    .ascii-art { font-family: monospace; font-size: 8px; line-height: 1.1; white-space: pre; color: #0066cc; margin-bottom: 30px; overflow-x: auto; }
    @media (min-width: 600px) { .ascii-art { font-size: 10px; } }
    h1 { color: #333; margin-top: 0; }
    h2 { margin-top: 24px; color: #333; font-size: 18px; }
    .card { background: white; border-radius: 8px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .token-box { background: #f5f5f5; border: 1px solid #ddd; border-radius: 6px; padding: 16px; word-break: break-all; font-family: monospace; font-size: 11px; max-height: 120px; overflow-y: auto; }
    .btn { display: inline-block; padding: 10px 18px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; text-decoration: none; margin-right: 8px; margin-top: 12px; }
    .btn:hover { background: #0052a3; }
    .btn-secondary { background: #6c757d; }
    .btn-secondary:hover { background: #545b62; }
    .success { color: #080; font-weight: 500; }
    .info { background: #d1ecf1; border: 1px solid #bee5eb; padding: 12px; border-radius: 6px; margin-top: 16px; color: #0c5460; font-size: 14px; }
    pre { background: #f5f5f5; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; margin: 0; }
    code { font-family: 'SF Mono', Monaco, 'Courier New', monospace; }
    .tabs { display: flex; gap: 0; border-bottom: 2px solid #e9ecef; margin-bottom: 16px; }
    .tab { padding: 10px 16px; cursor: pointer; border: none; background: none; font-size: 14px; color: #666; border-bottom: 2px solid transparent; margin-bottom: -2px; }
    .tab:hover { color: #333; }
    .tab.active { color: #0066cc; border-bottom-color: #0066cc; font-weight: 500; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .tool-note { font-size: 13px; color: #666; margin-bottom: 12px; }
    .expiry { font-size: 13px; color: #666; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="ascii-art">███████╗████████╗██████╗  █████╗ ████████╗ ██████╗
██╔════╝╚══██╔══╝██╔══██╗██╔══██╗╚══██╔══╝██╔═══██╗
███████╗   ██║   ██████╔╝███████║   ██║   ██║   ██║
╚════██║   ██║   ██╔══██╗██╔══██║   ██║   ██║   ██║
███████║   ██║   ██║  ██║██║  ██║   ██║   ╚██████╔╝
╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝

 ██████╗ ██████╗ ██╗██████╗ ██╗  ██╗ ██████╗  ██████╗ ██╗  ██╗
██╔════╝ ██╔══██╗██║██╔══██╗██║  ██║██╔═══██╗██╔═══██╗██║ ██╔╝
██║  ███╗██████╔╝██║██████╔╝███████║██║   ██║██║   ██║█████╔╝
██║   ██║██╔══██╗██║██╔═══╝ ██╔══██║██║   ██║██║   ██║██╔═██╗
╚██████╔╝██║  ██║██║██║     ██║  ██║╚██████╔╝╚██████╔╝██║  ██╗
 ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝     ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝</div>

  <div class="card">
    <h1>Authentication Successful</h1>
    <p class="success">✓ You're signed in and ready to connect your AI assistant.</p>

    <h2>Your Token</h2>
    <div class="token-box" id="token">${refreshToken}</div>
    <button class="btn" onclick="copyToken()">Copy Token</button>
    <button class="btn btn-secondary" onclick="downloadConfig()">Download .mcp.json</button>
    <p class="expiry">Valid for approximately <strong>${expiresInDays} days</strong>. The server handles refresh automatically.</p>
  </div>

  <div class="card">
    <h2>Setup Instructions</h2>
    <p class="tool-note">Choose your AI coding tool below for specific setup instructions.</p>

    <div class="tabs">
      <button class="tab active" onclick="showTab('claude-code')">Claude Code</button>
      <button class="tab" onclick="showTab('cursor')">Cursor</button>
      <button class="tab" onclick="showTab('cline')">Cline</button>
      <button class="tab" onclick="showTab('windsurf')">Windsurf</button>
      <button class="tab" onclick="showTab('opencode')">OpenCode</button>
    </div>

    <div id="claude-code" class="tab-content active">
      <p class="tool-note">Add to <code>.mcp.json</code> in your project root, or <code>~/.claude.json</code> for global access:</p>
      <pre><code>{
  "mcpServers": {
    "griphook": {
      "type": "http",
      "url": "${publicUrl}/mcp",
      "headers": {
        "Authorization": "Bearer ${refreshToken}"
      }
    }
  }
}</code></pre>
    </div>

    <div id="cursor" class="tab-content">
      <p class="tool-note">Add to <code>~/.cursor/mcp.json</code> (global) or <code>.cursor/mcp.json</code> (project):</p>
      <pre><code>{
  "mcpServers": {
    "griphook": {
      "type": "http",
      "url": "${publicUrl}/mcp",
      "headers": {
        "Authorization": "Bearer ${refreshToken}"
      }
    }
  }
}</code></pre>
    </div>

    <div id="cline" class="tab-content">
      <p class="tool-note">Open VS Code → Cline sidebar → MCP Servers icon → Configure → Edit <code>cline_mcp_settings.json</code>:</p>
      <pre><code>{
  "mcpServers": {
    "griphook": {
      "type": "sse",
      "url": "${publicUrl}/mcp/events",
      "headers": {
        "Authorization": "Bearer ${refreshToken}"
      }
    }
  }
}</code></pre>
    </div>

    <div id="windsurf" class="tab-content">
      <p class="tool-note">Open Windsurf Settings → Cascade → MCP Servers, or edit <code>~/.codeium/windsurf/mcp_config.json</code>:</p>
      <pre><code>{
  "mcpServers": {
    "griphook": {
      "type": "sse",
      "url": "${publicUrl}/mcp/events",
      "headers": {
        "Authorization": "Bearer ${refreshToken}"
      }
    }
  }
}</code></pre>
    </div>

    <div id="opencode" class="tab-content">
      <p class="tool-note">Add to <code>~/.config/opencode/opencode.json</code> (global) or <code>opencode.json</code> (project):</p>
      <pre><code>{
  "mcp": {
    "griphook": {
      "type": "remote",
      "url": "${publicUrl}/mcp",
      "headers": {
        "Authorization": "Bearer ${refreshToken}"
      }
    }
  }
}</code></pre>
    </div>

    <div class="info">
      <strong>Tip:</strong> Click "Download .mcp.json" above to get a ready-to-use config file for Claude Code and Cursor.
    </div>
  </div>

  <script>
    function copyToken() {
      const token = document.getElementById('token').textContent;
      navigator.clipboard.writeText(token).then(() => {
        event.target.textContent = 'Copied!';
        setTimeout(() => event.target.textContent = 'Copy Token', 2000);
      });
    }

    function downloadConfig() {
      const config = {
        mcpServers: {
          griphook: {
            type: "http",
            url: "${publicUrl}/mcp",
            headers: {
              Authorization: "Bearer ${refreshToken}"
            }
          }
        }
      };
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '.mcp.json';
      a.click();
      URL.revokeObjectURL(url);
    }

    function showTab(tabId) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelector(\`[onclick="showTab('\${tabId}')"]\`).classList.add('active');
      document.getElementById(tabId).classList.add('active');
    }
  </script>
</body>
</html>
`;

/**
 * Register login page routes (hosted mode only)
 */
function registerLoginRoutes(app: Express, config: GriphookConfig) {
  if (!config.hosted || !config.oauth) return;

  const { publicUrl } = config.hosted;
  const { clientId, clientSecret, openIdDiscoveryUrl } = config.oauth;
  const redirectUri = `${publicUrl}/login/callback`;

  // Login landing page
  app.get("/login", (_req, res) => {
    res.type("html").send(loginPageHtml());
  });

  // Start OAuth flow
  app.get("/login/start", async (_req, res) => {
    try {
      // Fetch OpenID configuration
      const oidcConfig = await axios.get(openIdDiscoveryUrl, { timeout: 10000 });
      const authEndpoint = oidcConfig.data.authorization_endpoint;

      // Generate PKCE and state
      const { verifier, challenge } = generatePkce();
      const state = randomBytes(16).toString("base64url");

      // Store state for verification (expires in 10 minutes)
      cleanupPendingLogins();
      pendingLogins.set(state, { verifier, expiresAt: Date.now() + 10 * 60 * 1000 });

      // Build authorization URL
      const authUrl = new URL(authEndpoint);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid email");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);

      res.redirect(authUrl.toString());
    } catch (err) {
      console.error("Login start error:", err);
      res.type("html").send(loginPageHtml("Failed to start login. Please try again."));
    }
  });

  // OAuth callback
  app.get("/login/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      res.type("html").send(loginPageHtml(String(error_description || error)));
      return;
    }

    if (!code || !state || typeof code !== "string" || typeof state !== "string") {
      res.type("html").send(loginPageHtml("Invalid callback parameters."));
      return;
    }

    // Verify state and get verifier
    const pending = pendingLogins.get(state);
    if (!pending || Date.now() > pending.expiresAt) {
      pendingLogins.delete(state);
      res.type("html").send(loginPageHtml("Login session expired. Please try again."));
      return;
    }
    pendingLogins.delete(state);

    try {
      // Fetch OpenID configuration
      const oidcConfig = await axios.get(openIdDiscoveryUrl, { timeout: 10000 });
      const tokenEndpoint = oidcConfig.data.token_endpoint;

      // Exchange code for tokens
      const params = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: pending.verifier,
      });

      if (clientSecret) {
        params.set("client_secret", clientSecret);
      }

      const tokenResponse = await axios.post(tokenEndpoint, params.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 30000,
      });

      const { refresh_token, refresh_expires_in } = tokenResponse.data;

      if (!refresh_token) {
        res.type("html").send(loginPageHtml("No refresh token received. Please contact administrator."));
        return;
      }

      // Convert refresh_expires_in (seconds) to days for display
      const expiresInDays = Math.floor((refresh_expires_in || 259200) / 86400); // Default 3 days if not provided
      res.type("html").send(tokenPageHtml(refresh_token, expiresInDays, publicUrl));
    } catch (err) {
      console.error("Token exchange error:", err);
      res.type("html").send(loginPageHtml("Failed to complete login. Please try again."));
    }
  });

  console.log(`Login page: ${publicUrl}/login`);
}

/**
 * Exchange a refresh token for an access token.
 * Uses caching to avoid unnecessary token exchanges.
 */
async function getAccessTokenFromRefresh(
  refreshToken: string,
  config: GriphookConfig,
): Promise<{ accessToken: string } | { error: string }> {
  // Hash the refresh token for cache key (don't store raw tokens as keys)
  const cacheKey = createHash("sha256").update(refreshToken).digest("hex");

  // Check cache first
  const cached = accessTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return { accessToken: cached.accessToken };
  }

  // Exchange refresh token for access token
  if (!config.oauth) {
    return { error: "OAuth not configured" };
  }

  try {
    const oidcConfig = await axios.get(config.oauth.openIdDiscoveryUrl, { timeout: 10000 });
    const tokenEndpoint = oidcConfig.data.token_endpoint;

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.oauth.clientId,
      refresh_token: refreshToken,
    });

    if (config.oauth.clientSecret) {
      params.set("client_secret", config.oauth.clientSecret);
    }

    const tokenResponse = await axios.post(tokenEndpoint, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30000,
    });

    const { access_token, expires_in } = tokenResponse.data;

    // Cache the access token
    accessTokenCache.set(cacheKey, {
      accessToken: access_token,
      expiresAt: Date.now() + (expires_in * 1000),
    });

    return { accessToken: access_token };
  } catch (err) {
    // Clear cache on error
    accessTokenCache.delete(cacheKey);
    if (axios.isAxiosError(err) && err.response?.status === 400) {
      return { error: "Refresh token is invalid or expired" };
    }
    return { error: "Failed to exchange refresh token" };
  }
}

/**
 * Express middleware to verify Bearer token in hosted mode.
 * In hosted mode, requests must include a valid refresh token.
 * The middleware exchanges the refresh token for an access token.
 */
function createHostedAuthMiddleware(config: GriphookConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip auth for well-known endpoints
    if (req.path.startsWith("/.well-known/")) {
      return next();
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401)
        .set("WWW-Authenticate", buildWwwAuthenticateHeader(config))
        .json({
          error: "unauthorized",
          error_description: "Bearer token required. See WWW-Authenticate header for OAuth metadata.",
        });
      return;
    }

    const refreshToken = authHeader.slice(7); // Remove "Bearer " prefix

    // Exchange refresh token for access token
    const result = await getAccessTokenFromRefresh(refreshToken, config);

    if ("error" in result) {
      res.status(401)
        .set("WWW-Authenticate", buildWwwAuthenticateHeader(config))
        .json({
          error: "invalid_token",
          error_description: result.error,
        });
      return;
    }

    // Attach access token to request for downstream use
    (req as any).stratoToken = result.accessToken;
    next();
  };
}

function buildServer(config: ReturnType<typeof loadConfig>) {
  const instructions = [
    "Griphook MCP server exposes the STRATO web app backend. Run 'griphook login' to authenticate via browser.",
    `API base: ${config.apiBaseUrl}. Override with STRATO_API_BASE_URL.`,
    "Domain tools: strato.tokens, strato.swap, strato.lending, strato.cdp, strato.bridge, strato.rewards, strato.admin, strato.events, strato.protocol-fees, strato.rpc.",
    `HTTP transport: ${config.http.enabled ? `POST ${config.http.host}:${config.http.port}${config.http.path}` : "disabled (set GRIPHOOK_HTTP_ENABLED=true)"}.`,
  ].join("\n");

  const server = new McpServer(
    { name: "griphook", version },
    { capabilities: { logging: {} }, instructions },
  );

  const client = new GriphookClient(config);

  registerResources(server, config);
  registerTools(server, client, config);

  return server;
}

async function startStdioServer(config: ReturnType<typeof loadConfig>) {
  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return async () => {
    await server.close();
  };
}

async function startHttpServer(config: ReturnType<typeof loadConfig>) {
  if (!config.http.enabled) return undefined;

  const server = buildServer(config);
  const transport = new StreamableHTTPServerTransport();
  await server.connect(transport);

  // In hosted mode, we need to allow the public hostname in addition to localhost
  const allowedHosts = config.hosted
    ? [config.http.host, "localhost", "127.0.0.1", new URL(config.hosted.publicUrl).hostname]
    : undefined;
  const app = createMcpExpressApp({ host: config.http.host, allowedHosts });

  // Register login pages (works in both hosted and local modes if OAuth is configured)
  registerLoginRoutes(app, config);

  // In hosted mode, add OAuth discovery and auth middleware
  if (config.hosted) {
    // RFC 9728 Protected Resource Metadata endpoint
    app.get("/.well-known/oauth-protected-resource", (_req, res) => {
      const metadata = getProtectedResourceMetadata(config);
      if (!metadata) {
        res.status(503).json({ error: "OAuth not configured" });
        return;
      }
      res.json(metadata);
    });

    // Apply auth middleware to MCP endpoints
    app.use(config.http.path, createHostedAuthMiddleware(config));
    app.use(config.http.ssePath, createHostedAuthMiddleware(config));

    console.log(`Hosted mode enabled: ${config.hosted.publicUrl}`);
    console.log(`OAuth metadata: ${config.hosted.publicUrl}/.well-known/oauth-protected-resource`);
  }

  app.post(config.http.path, (req, res) => transport.handleRequest(req, res, (req as any).body));
  app.get(config.http.ssePath, (req, res) => transport.handleRequest(req, res));

  const listener = app.listen(config.http.port, config.http.host, () => {
    console.log(
      `Griphook MCP HTTP listening on http://${config.http.host}:${config.http.port}${config.http.path} (SSE at ${config.http.ssePath})`,
    );
  });

  return async () => {
    listener.close();
    await server.close();
  };
}

export async function start() {
  const config = loadConfig();
  const closers: Array<() => Promise<void>> = [];

  try {
    const closeStdio = await startStdioServer(config);
    closers.push(closeStdio);
  } catch (err) {
    console.error("Failed to start Griphook MCP stdio server:", err);
  }

  try {
    const closeHttp = await startHttpServer(config);
    if (closeHttp) {
      closers.push(closeHttp);
    }
  } catch (err) {
    console.error("Failed to start Griphook MCP HTTP server:", err);
  }

  process.on("SIGINT", async () => {
    await Promise.allSettled(closers.map((close) => close()));
    process.exit(0);
  });
}

// Run directly when executed as main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  start().catch((err) => {
    console.error("Failed to start Griphook MCP server:", err);
    process.exit(1);
  });
}
