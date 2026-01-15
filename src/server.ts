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
import { requestContext } from "./requestContext.js";
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
  <title>Griphook - MCP Server for STRATO</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    @keyframes flicker {
      0%, 100% { opacity: 1; }
      92% { opacity: 0.95; }
      94% { opacity: 0.9; }
      96% { opacity: 0.95; }
    }
    @keyframes glow {
      0%, 100% { text-shadow: 0 0 5px #0f0, 0 0 10px #0f0, 0 0 15px #0f0; }
      50% { text-shadow: 0 0 10px #0f0, 0 0 20px #0f0, 0 0 30px #0f0; }
    }
    @keyframes scanline {
      0% { transform: translateY(-100%); }
      100% { transform: translateY(100vh); }
    }
    @keyframes blink { 50% { opacity: 0; } }
    * { box-sizing: border-box; }
    body {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Courier New', monospace;
      background: #0a0a0a;
      color: #00ff00;
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      animation: flicker 4s infinite;
    }
    body::before {
      content: "";
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: repeating-linear-gradient(
        0deg,
        rgba(0, 0, 0, 0.15),
        rgba(0, 0, 0, 0.15) 1px,
        transparent 1px,
        transparent 2px
      );
      pointer-events: none;
      z-index: 1000;
    }
    body::after {
      content: "";
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 4px;
      background: rgba(0, 255, 0, 0.1);
      animation: scanline 8s linear infinite;
      pointer-events: none;
      z-index: 1001;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    .ascii-art {
      font-size: 6px;
      line-height: 1.0;
      white-space: pre;
      color: #00ff00;
      margin-bottom: 24px;
      text-align: center;
      text-shadow: 0 0 10px #00ff00;
      animation: glow 2s ease-in-out infinite;
    }
    @media (min-width: 700px) { .ascii-art { font-size: 8px; } }
    .panel {
      border: 1px solid #00ff00;
      background: rgba(0, 20, 0, 0.8);
      margin-bottom: 16px;
      box-shadow: 0 0 10px rgba(0, 255, 0, 0.3), inset 0 0 20px rgba(0, 255, 0, 0.05);
    }
    .panel-header {
      padding: 10px 16px;
      border-bottom: 1px solid #00ff00;
      color: #00ff00;
      font-weight: bold;
      font-size: 14px;
      text-shadow: 0 0 5px #00ff00;
      background: rgba(0, 255, 0, 0.1);
    }
    .panel-body {
      padding: 16px;
    }
    .panel-body p {
      margin: 0 0 12px 0;
      line-height: 1.6;
      color: #00cc00;
    }
    .panel-body p:last-child { margin-bottom: 0; }
    a { color: #00ff00; text-decoration: underline; }
    a:hover { color: #66ff66; text-shadow: 0 0 5px #00ff00; }
    .highlight { color: #00ff00; text-shadow: 0 0 5px #00ff00; }
    .error-box {
      background: rgba(255, 0, 0, 0.1);
      border: 1px solid #ff0000;
      color: #ff4444;
      padding: 12px 16px;
      margin-bottom: 16px;
      text-shadow: 0 0 5px #ff0000;
    }
    .btn {
      display: inline-block;
      padding: 12px 24px;
      background: transparent;
      color: #00ff00;
      text-decoration: none;
      font-size: 14px;
      font-weight: bold;
      font-family: inherit;
      border: 1px solid #00ff00;
      cursor: pointer;
      text-shadow: 0 0 5px #00ff00;
      box-shadow: 0 0 10px rgba(0, 255, 0, 0.3);
      transition: all 0.2s;
    }
    .btn:hover {
      background: #00ff00;
      color: #000;
      text-shadow: none;
      box-shadow: 0 0 20px rgba(0, 255, 0, 0.5);
    }
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin: 16px 0;
    }
    .feature {
      background: rgba(0, 255, 0, 0.05);
      border: 1px solid #004400;
      padding: 12px;
    }
    .feature-title {
      color: #00ff00;
      font-weight: bold;
      margin-bottom: 6px;
      font-size: 13px;
      text-shadow: 0 0 3px #00ff00;
    }
    .feature-desc {
      color: #009900;
      font-size: 12px;
      line-height: 1.4;
    }
    .tools-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .tool-badge {
      background: transparent;
      border: 1px solid #006600;
      padding: 4px 12px;
      font-size: 12px;
      color: #00aa00;
    }
    .stats {
      display: flex;
      gap: 32px;
      margin: 16px 0;
      flex-wrap: wrap;
    }
    .stat {
      text-align: center;
    }
    .stat-value {
      font-size: 28px;
      font-weight: bold;
      color: #00ff00;
      text-shadow: 0 0 10px #00ff00;
    }
    .stat-label {
      font-size: 11px;
      color: #006600;
      text-transform: uppercase;
    }
    .footer {
      text-align: center;
      padding: 16px;
      color: #006600;
      font-size: 11px;
    }
    .footer a { color: #006600; text-decoration: none; }
    .footer a:hover { color: #00aa00; }
    .blink { animation: blink 1s step-end infinite; }
    .cursor { color: #00ff00; }
  </style>
</head>
<body>
  <div class="container">
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

    ${error ? `<div class="error-box">> ERROR: ${error}</div>` : ""}

    <div class="panel">
      <div class="panel-header">[ ABOUT ]</div>
      <div class="panel-body">
        <p>> Griphook is an <span class="highlight">MCP (Model Context Protocol) server</span> that connects AI coding assistants to the <a href="https://strato.nexus" target="_blank">STRATO blockchain</a>.<span class="blink cursor">_</span></p>
        <p>> Your AI can read on-chain data, execute DeFi operations, and interact with the full STRATO ecosystem directly from your IDE.</p>

        <div class="stats">
          <div class="stat">
            <div class="stat-value">67</div>
            <div class="stat-label">MCP Tools</div>
          </div>
          <div class="stat">
            <div class="stat-value">6</div>
            <div class="stat-label">Protocols</div>
          </div>
          <div class="stat">
            <div class="stat-value">∞</div>
            <div class="stat-label">Possibilities</div>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">[ AUTHENTICATE ]</div>
      <div class="panel-body">
        <p>> Sign in with your STRATO account to get an authentication token.</p>
        <p>> After signing in, you'll receive setup instructions for your AI tool.</p>
        <p style="margin-top: 16px;">
          <a href="/login/start" class="btn">[ SIGN IN WITH STRATO ]</a>
        </p>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">[ CAPABILITIES ]</div>
      <div class="panel-body">
        <div class="feature-grid">
          <div class="feature">
            <div class="feature-title">Token Management</div>
            <div class="feature-desc">Query balances, transfer tokens, check prices, manage approvals</div>
          </div>
          <div class="feature">
            <div class="feature-title">DEX / Swap</div>
            <div class="feature-desc">Execute swaps, provide liquidity, create pools, view LP positions</div>
          </div>
          <div class="feature">
            <div class="feature-title">Lending Markets</div>
            <div class="feature-desc">Supply collateral, borrow USDST, repay loans, manage positions</div>
          </div>
          <div class="feature">
            <div class="feature-title">CDP Vaults</div>
            <div class="feature-desc">Open vaults, mint stablecoins, manage collateral ratios</div>
          </div>
          <div class="feature">
            <div class="feature-title">Cross-Chain Bridge</div>
            <div class="feature-desc">Bridge assets between STRATO and external networks</div>
          </div>
          <div class="feature">
            <div class="feature-title">Rewards & Governance</div>
            <div class="feature-desc">Claim CATA rewards, stake tokens, vote on proposals</div>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">[ SUPPORTED TOOLS ]</div>
      <div class="panel-body">
        <p>> Compatible with MCP-enabled AI coding assistants:</p>
        <div class="tools-list">
          <span class="tool-badge">Claude Code</span>
          <span class="tool-badge">Cursor</span>
          <span class="tool-badge">VS Code Copilot</span>
          <span class="tool-badge">Cline</span>
          <span class="tool-badge">OpenCode</span>
          <span class="tool-badge">Kilo Code</span>
          <span class="tool-badge">Codex</span>
        </div>
      </div>
    </div>

    <div class="footer">
      <a href="https://strato.nexus">strato.nexus</a> · <a href="https://github.com/strato-net/strato-griphook">GitHub</a> · <a href="https://modelcontextprotocol.io">MCP Protocol</a>
    </div>
  </div>
</body>
</html>
`;

const tokenPageHtml = (refreshToken: string, expiresInDays: number, publicUrl: string) => `
<!DOCTYPE html>
<html>
<head>
  <title>Griphook - Authentication Complete</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    @keyframes flicker {
      0%, 100% { opacity: 1; }
      92% { opacity: 0.95; }
      94% { opacity: 0.9; }
      96% { opacity: 0.95; }
    }
    @keyframes glow {
      0%, 100% { text-shadow: 0 0 5px #0f0, 0 0 10px #0f0, 0 0 15px #0f0; }
      50% { text-shadow: 0 0 10px #0f0, 0 0 20px #0f0, 0 0 30px #0f0; }
    }
    @keyframes scanline {
      0% { transform: translateY(-100%); }
      100% { transform: translateY(100vh); }
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Courier New', monospace;
      background: #0a0a0a;
      color: #00ff00;
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      animation: flicker 4s infinite;
    }
    body::before {
      content: "";
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: repeating-linear-gradient(
        0deg,
        rgba(0, 0, 0, 0.15),
        rgba(0, 0, 0, 0.15) 1px,
        transparent 1px,
        transparent 2px
      );
      pointer-events: none;
      z-index: 1000;
    }
    body::after {
      content: "";
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 4px;
      background: rgba(0, 255, 0, 0.1);
      animation: scanline 8s linear infinite;
      pointer-events: none;
      z-index: 1001;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      position: relative;
    }
    .ascii-art {
      font-size: 6px;
      line-height: 1.0;
      white-space: pre;
      color: #00ff00;
      margin-bottom: 24px;
      text-align: center;
      text-shadow: 0 0 10px #00ff00;
      animation: glow 2s ease-in-out infinite;
    }
    @media (min-width: 700px) { .ascii-art { font-size: 8px; } }
    .panel {
      border: 1px solid #00ff00;
      background: rgba(0, 20, 0, 0.8);
      margin-bottom: 16px;
      box-shadow: 0 0 10px rgba(0, 255, 0, 0.3), inset 0 0 20px rgba(0, 255, 0, 0.05);
    }
    .panel-header {
      padding: 10px 16px;
      border-bottom: 1px solid #00ff00;
      color: #00ff00;
      font-weight: bold;
      font-size: 14px;
      text-shadow: 0 0 5px #00ff00;
      background: rgba(0, 255, 0, 0.1);
    }
    .panel-body {
      padding: 16px;
    }
    .panel-body p {
      margin: 0 0 12px 0;
      line-height: 1.6;
      color: #00cc00;
    }
    .panel-body p:last-child { margin-bottom: 0; }
    a { color: #00ff00; text-decoration: underline; }
    a:hover { color: #66ff66; text-shadow: 0 0 5px #00ff00; }
    .success { color: #00ff00; text-shadow: 0 0 10px #00ff00; }
    .token-box {
      background: #001a00;
      border: 1px solid #006600;
      padding: 12px;
      word-break: break-all;
      font-size: 10px;
      color: #00cc00;
      max-height: 100px;
      overflow-y: auto;
    }
    .btn {
      display: inline-block;
      padding: 10px 20px;
      background: transparent;
      color: #00ff00;
      text-decoration: none;
      font-size: 13px;
      font-weight: bold;
      font-family: inherit;
      border: 1px solid #00ff00;
      cursor: pointer;
      margin-right: 8px;
      margin-top: 12px;
      text-shadow: 0 0 5px #00ff00;
      box-shadow: 0 0 5px rgba(0, 255, 0, 0.3);
      transition: all 0.2s;
    }
    .btn:hover {
      background: #00ff00;
      color: #000;
      text-shadow: none;
      box-shadow: 0 0 15px rgba(0, 255, 0, 0.5);
    }
    .btn-secondary {
      border-color: #006600;
      color: #00aa00;
      text-shadow: 0 0 3px #006600;
      box-shadow: 0 0 3px rgba(0, 255, 0, 0.2);
    }
    .btn-secondary:hover {
      background: #006600;
      color: #00ff00;
    }
    .expiry {
      font-size: 12px;
      color: #009900;
      margin-top: 12px;
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 0;
      border-bottom: 1px solid #006600;
      margin-bottom: 16px;
    }
    .tab {
      padding: 8px 14px;
      cursor: pointer;
      border: none;
      background: transparent;
      font-size: 12px;
      font-family: inherit;
      color: #006600;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: all 0.2s;
    }
    .tab:hover { color: #00aa00; }
    .tab.active {
      color: #00ff00;
      border-bottom-color: #00ff00;
      text-shadow: 0 0 5px #00ff00;
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .tool-note {
      font-size: 12px;
      color: #009900;
      margin-bottom: 12px;
    }
    .tool-note code {
      color: #00ff00;
      background: #001a00;
      padding: 2px 6px;
    }
    pre {
      background: #001a00;
      border: 1px solid #004400;
      padding: 12px;
      overflow-x: auto;
      font-size: 11px;
      margin: 0;
      color: #00cc00;
    }
    code { font-family: inherit; }
    .info-box {
      background: rgba(0, 255, 0, 0.05);
      border: 1px solid #004400;
      padding: 12px;
      margin-top: 16px;
      font-size: 12px;
      color: #009900;
    }
    .info-box strong { color: #00cc00; }
    .footer {
      text-align: center;
      padding: 16px;
      color: #006600;
      font-size: 11px;
    }
    .footer a { color: #006600; }
    .footer a:hover { color: #00aa00; }
    .blink { animation: blink 1s step-end infinite; }
    @keyframes blink { 50% { opacity: 0; } }
  </style>
</head>
<body>
  <div class="container">
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

    <div class="panel">
      <div class="panel-header">[ AUTHENTICATION COMPLETE ]</div>
      <div class="panel-body">
        <p class="success">> STATUS: CONNECTED<span class="blink">_</span></p>
        <p>You're authenticated and ready to connect your AI coding assistant to STRATO.</p>

        <p style="margin-top: 16px; color: #00aa00;">YOUR TOKEN:</p>
        <div class="token-box" id="token">${refreshToken}</div>
        <button class="btn" onclick="copyToken()">[ COPY TOKEN ]</button>
        <button class="btn btn-secondary" onclick="downloadConfig()">[ DOWNLOAD .mcp.json ]</button>
        <p class="expiry">> Token valid for ~${expiresInDays} days. Server handles refresh automatically.</p>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">[ SETUP INSTRUCTIONS ]</div>
      <div class="panel-body">
        <p class="tool-note">Select your AI coding tool:</p>

        <div class="tabs">
          <button class="tab active" onclick="showTab('claude-code')">Claude Code</button>
          <button class="tab" onclick="showTab('cursor')">Cursor</button>
          <button class="tab" onclick="showTab('vscode-copilot')">VS Code Copilot</button>
          <button class="tab" onclick="showTab('cline')">Cline</button>
          <button class="tab" onclick="showTab('opencode')">OpenCode</button>
          <button class="tab" onclick="showTab('kilo-code')">Kilo Code</button>
          <button class="tab" onclick="showTab('codex')">Codex</button>
        </div>

        <div id="claude-code" class="tab-content active">
          <p class="tool-note">Add to <code>.mcp.json</code> in project root, or <code>~/.claude.json</code> for global:</p>
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
          <p class="tool-note" style="margin-top: 12px; color: #996600;">⚠ Known issue: Tools may appear in sidebar but not be callable in chat. Try global config and restart Cursor.</p>
        </div>

        <div id="vscode-copilot" class="tab-content">
          <p class="tool-note">Add to <code>.vscode/mcp.json</code> in project root:</p>
          <pre><code>{
  "servers": {
    "griphook": {
      "type": "http",
      "url": "${publicUrl}/mcp",
      "headers": {
        "Authorization": "Bearer ${refreshToken}"
      }
    }
  }
}</code></pre>
          <p class="tool-note" style="margin-top: 12px;">Requires VS Code 1.102+ with Agent Mode enabled (<code>chat.agent.enabled</code>).</p>
        </div>

        <div id="cline" class="tab-content">
          <p class="tool-note">VS Code → Cline sidebar → MCP Servers → Configure → <code>cline_mcp_settings.json</code>:</p>
          <pre><code>{
  "mcpServers": {
    "griphook": {
      "type": "streamableHttp",
      "url": "${publicUrl}/mcp",
      "headers": {
        "Authorization": "Bearer ${refreshToken}"
      }
    }
  }
}</code></pre>
        </div>

        <div id="opencode" class="tab-content">
          <p class="tool-note">Add to <code>opencode.json</code> in project root or <code>~/.config/opencode/opencode.json</code>:</p>
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

        <div id="kilo-code" class="tab-content">
          <p class="tool-note">Add to <code>.kilocode/mcp.json</code> in project root:</p>
          <pre><code>{
  "mcpServers": {
    "griphook": {
      "type": "streamable-http",
      "url": "${publicUrl}/mcp",
      "headers": {
        "Authorization": "Bearer ${refreshToken}"
      }
    }
  }
}</code></pre>
        </div>

        <div id="codex" class="tab-content">
          <p class="tool-note">Add to <code>~/.codex/config.toml</code>:</p>
          <pre><code>[mcp_servers.griphook]
type = "http"
url = "${publicUrl}/mcp"

[mcp_servers.griphook.headers]
Authorization = "Bearer ${refreshToken}"</code></pre>
          <p class="tool-note" style="margin-top: 12px;">Or use: <code>codex mcp add griphook ${publicUrl}/mcp</code></p>
        </div>

        <div class="info-box">
          <strong>TIP:</strong> Click "DOWNLOAD .mcp.json" for a ready-to-use Claude Code config file.
        </div>
      </div>
    </div>

    <div class="footer">
      <a href="https://strato.nexus">strato.nexus</a> · <a href="https://github.com/strato-net/strato-griphook">GitHub</a> · <a href="https://modelcontextprotocol.io">MCP Protocol</a>
    </div>
  </div>

  <script>
    function copyToken() {
      const token = document.getElementById('token').textContent;
      navigator.clipboard.writeText(token).then(() => {
        event.target.textContent = '[ COPIED! ]';
        setTimeout(() => event.target.textContent = '[ COPY TOKEN ]', 2000);
      });
    }

    function downloadConfig() {
      const token = document.getElementById('token').textContent;
      const config = {
        mcpServers: {
          griphook: {
            type: "http",
            url: "${publicUrl}/mcp",
            headers: {
              Authorization: "Bearer " + token
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
    console.log("[getAccessTokenFromRefresh] Fetching OIDC config from:", config.oauth.openIdDiscoveryUrl);
    const oidcConfig = await axios.get(config.oauth.openIdDiscoveryUrl, { timeout: 10000 });
    const tokenEndpoint = oidcConfig.data.token_endpoint;
    console.log("[getAccessTokenFromRefresh] Token endpoint:", tokenEndpoint);

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.oauth.clientId,
      refresh_token: refreshToken,
    });

    if (config.oauth.clientSecret) {
      params.set("client_secret", config.oauth.clientSecret);
      console.log("[getAccessTokenFromRefresh] Using client_secret (length:", config.oauth.clientSecret.length, ")");
    } else {
      console.log("[getAccessTokenFromRefresh] WARNING: No client_secret configured");
    }

    const tokenResponse = await axios.post(tokenEndpoint, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30000,
    });

    const { access_token, expires_in } = tokenResponse.data;
    console.log("[getAccessTokenFromRefresh] Success! Token expires in:", expires_in, "seconds");

    // Cache the access token
    accessTokenCache.set(cacheKey, {
      accessToken: access_token,
      expiresAt: Date.now() + (expires_in * 1000),
    });

    return { accessToken: access_token };
  } catch (err) {
    // Clear cache on error
    accessTokenCache.delete(cacheKey);
    if (axios.isAxiosError(err)) {
      console.error("[getAccessTokenFromRefresh] Error:", err.response?.status, err.response?.data);
      if (err.response?.status === 400) {
        return { error: `Refresh token is invalid or expired: ${JSON.stringify(err.response.data)}` };
      }
    } else {
      console.error("[getAccessTokenFromRefresh] Non-axios error:", err);
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

  // Wrap MCP request handlers with request context to pass the access token
  app.post(config.http.path, (req, res) => {
    const accessToken = (req as any).stratoToken;
    requestContext.run({ accessToken }, () => {
      transport.handleRequest(req, res, (req as any).body);
    });
  });
  app.get(config.http.ssePath, (req, res) => {
    const accessToken = (req as any).stratoToken;
    requestContext.run({ accessToken }, () => {
      transport.handleRequest(req, res);
    });
  });

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
