import "dotenv/config";
import { createRequire } from "module";
import type { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, GriphookConfig } from "./config.js";
import { GriphookClient } from "./client.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

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
