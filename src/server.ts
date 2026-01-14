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
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; }
    h1 { color: #333; }
    .btn { display: inline-block; padding: 12px 24px; background: #0066cc; color: white; text-decoration: none; border-radius: 6px; font-size: 16px; }
    .btn:hover { background: #0052a3; }
    .error { background: #fee; border: 1px solid #c00; padding: 12px; border-radius: 6px; margin-bottom: 20px; }
    p { line-height: 1.6; color: #555; }
  </style>
</head>
<body>
  <h1>Griphook Login</h1>
  ${error ? `<div class="error">${error}</div>` : ""}
  <p>Sign in to get an access token for use with MCP clients that don't support OAuth (like Claude Code, Cursor, or Cline).</p>
  <p><a href="/login/start" class="btn">Sign in with STRATO</a></p>
</body>
</html>
`;

const tokenPageHtml = (token: string, expiresIn: number, publicUrl: string) => `
<!DOCTYPE html>
<html>
<head>
  <title>Griphook - Your Token</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
    h1 { color: #333; }
    .token-box { background: #f5f5f5; border: 1px solid #ddd; border-radius: 6px; padding: 16px; word-break: break-all; font-family: monospace; font-size: 12px; max-height: 200px; overflow-y: auto; }
    .copy-btn { display: inline-block; padding: 8px 16px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; margin-top: 12px; font-size: 14px; }
    .copy-btn:hover { background: #0052a3; }
    .success { color: #080; }
    .warning { background: #fff3cd; border: 1px solid #ffc107; padding: 12px; border-radius: 6px; margin-top: 20px; }
    pre { background: #f5f5f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
    code { font-family: monospace; }
    h2 { margin-top: 30px; color: #333; }
  </style>
</head>
<body>
  <h1>Your Access Token</h1>
  <p class="success">✓ Authentication successful!</p>

  <h2>Token</h2>
  <div class="token-box" id="token">${token}</div>
  <button class="copy-btn" onclick="copyToken()">Copy Token</button>

  <div class="warning">
    <strong>Note:</strong> This token expires in ${Math.floor(expiresIn / 60)} minutes. You'll need to return here to get a new token when it expires.
  </div>

  <h2>MCP Client Configuration</h2>
  <p>Add this to your MCP client settings (e.g., Claude Code <code>claude_desktop_config.json</code>):</p>
  <pre><code>{
  "mcpServers": {
    "griphook": {
      "url": "${publicUrl}/mcp",
      "headers": {
        "Authorization": "Bearer &lt;paste-token-here&gt;"
      }
    }
  }
}</code></pre>

  <script>
    function copyToken() {
      const token = document.getElementById('token').textContent;
      navigator.clipboard.writeText(token).then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy Token', 2000);
      });
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

      const { access_token, expires_in } = tokenResponse.data;
      res.type("html").send(tokenPageHtml(access_token, expires_in, publicUrl));
    } catch (err) {
      console.error("Token exchange error:", err);
      res.type("html").send(loginPageHtml("Failed to complete login. Please try again."));
    }
  });

  console.log(`Login page: ${publicUrl}/login`);
}

/**
 * Express middleware to verify Bearer token in hosted mode.
 * In hosted mode, requests must include a valid Bearer token.
 * The token is validated by making a request to the STRATO API.
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

    const token = authHeader.slice(7); // Remove "Bearer " prefix

    // Validate token by making a test request to STRATO API
    // This also ensures the token has access to STRATO resources
    try {
      const response = await fetch(`${config.apiBaseUrl}/tokens/balance`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        res.status(401)
          .set("WWW-Authenticate", buildWwwAuthenticateHeader(config))
          .json({
            error: "invalid_token",
            error_description: "Token is invalid or expired",
          });
        return;
      }

      // Attach token to request for downstream use
      (req as any).stratoToken = token;
      next();
    } catch (err) {
      res.status(401)
        .set("WWW-Authenticate", buildWwwAuthenticateHeader(config))
        .json({
          error: "invalid_token",
          error_description: "Failed to validate token",
        });
    }
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
