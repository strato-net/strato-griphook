# Griphook

```
███████╗████████╗██████╗  █████╗ ████████╗ ██████╗
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
 ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝     ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝
```

Griphook is an MCP (Model Context Protocol) server that connects AI agents to the [STRATO](https://strato.nexus) blockchain platform.

## What is STRATO?

[STRATO](https://strato.nexus) is a blockchain platform with a comprehensive DeFi ecosystem including token management, decentralized exchange, lending markets, CDP vaults, cross-chain bridging, and governance.

## What is Griphook?

Griphook lets AI assistants like Claude interact with STRATO. Through 67 MCP tools, your AI can:

- **Read** token balances, swap pools, lending positions, CDP vaults, and protocol metrics
- **Execute** swaps, lending operations, borrowing, bridging, and reward claims
- **Manage** platform administration and governance voting

## Quick Start

Public hosted instances are available for both production and testnet:

| Environment | Login URL | MCP Endpoint |
|-------------|-----------|--------------|
| **Production** | https://griphook.strato.nexus/login | `https://griphook.strato.nexus/mcp` |
| **Testnet** | https://griphook.testnet.strato.nexus/login | `https://griphook.testnet.strato.nexus/mcp` |

1. Visit the login URL to sign in and get a token
2. Add to your MCP config (e.g., `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "griphook": {
      "type": "http",
      "url": "https://griphook.strato.nexus/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

See [AI Coding Tool Compatibility](#ai-coding-tool-compatibility) for tool-specific configurations.

## Using the CLI Locally

Build and run the local CLI:

```bash
npm install
npm run build
```

Create `.env` from `.env.sample`, then set at least:

- `STRATO_API_BASE_URL` or `STRATO_NODE_URL`
- `OPENID_DISCOVERY_URL`
- `OAUTH_CLIENT_ID`
- `OAUTH_CLIENT_SECRET`

CLI auth + basic commands:

```bash
node dist/cli.js login
node dist/cli.js status
node dist/cli.js token
node dist/cli.js logout
```

Tool discovery and invocation:

```bash
node dist/cli.js tools
node dist/cli.js tools strato.tokens
node dist/cli.js strato.tokens --includeBalances
node dist/cli.js strato.tokens --includeBalances --json
```

Important CLI behavior:

- `node dist/cli.js` with no command starts the MCP server (`serve` mode).
- Tool flags are schema-validated: unknown flags fail fast.
- Non-boolean flags require a value, for example `--tokenAddress <value>`.
- `--no-<flag>` is only valid for boolean inputs.
- Credentials are stored at `~/.griphook/credentials.json`.

### `.env` Examples

Mainnet example:

```bash
STRATO_API_BASE_URL=https://app.strato.nexus/api
OPENID_DISCOVERY_URL=https://keycloak.blockapps.net/auth/realms/mercata/.well-known/openid-configuration
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
```

Testnet example:

```bash
STRATO_API_BASE_URL=https://buildtest.mercata-testnet.blockapps.net/api
OPENID_DISCOVERY_URL=https://keycloak.blockapps.net/auth/realms/mercata/.well-known/openid-configuration
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
```

### Common CLI Recipes

Most commands below require an active login (`node dist/cli.js login`).

Show available tools:

```bash
node dist/cli.js tools
```

Show inputs for a specific tool:

```bash
node dist/cli.js tools strato.tokens
```

Fetch token + voucher balances (current user):

```bash
node dist/cli.js strato.tokens --includeBalances --json
```

Fetch token catalog (can be large):

```bash
node dist/cli.js strato.tokens --includeTokens --status eq.2 --json
```

Inspect swap pools and your LP positions:

```bash
node dist/cli.js strato.swap --includePositions --json
```

Inspect a specific token pair in swap:

```bash
node dist/cli.js strato.swap --tokenA <tokenA-address> --tokenB <tokenB-address> --json
```

Fetch lending dashboard with interest:

```bash
node dist/cli.js strato.lending --includeInterest --json
```

Fetch CDP overview with stats:

```bash
node dist/cli.js strato.cdp --includeStats --json
```

Fetch rewards and leaderboard:

```bash
node dist/cli.js strato.rewards --includeLeaderboard --leaderboardLimit 20 --json
```

Search chain events:

```bash
node dist/cli.js strato.events --limit 25 --order block_timestamp.desc --json
```

Run against another environment without editing `.env`:

```bash
STRATO_API_BASE_URL=https://app.strato.nexus/api \
  node dist/cli.js strato.tokens --includeBalances --json
```

## Running Your Own Instance

To run your own Griphook server, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "griphook": {
      "command": "node",
      "args": ["/path/to/griphook/dist/cli.js", "serve"],
      "env": {
        "OAUTH_CLIENT_ID": "your-client-id",
        "OAUTH_CLIENT_SECRET": "your-client-secret",
        "OPENID_DISCOVERY_URL": "https://keycloak.blockapps.net/auth/realms/mercata/.well-known/openid-configuration",
        "STRATO_API_BASE_URL": "https://buildtest.mercata-testnet.blockapps.net/api"
      }
    }
  }
}
```

### Environment Variables

#### Required for Login
| Variable | Description |
|----------|-------------|
| `OAUTH_CLIENT_ID` | OAuth 2.0 client ID |
| `OAUTH_CLIENT_SECRET` | OAuth 2.0 client secret |
| `OPENID_DISCOVERY_URL` | OpenID Connect discovery endpoint |

#### Required for Server and CLI API Calls
| Variable | Default | Description |
|----------|---------|-------------|
| `STRATO_API_BASE_URL` | `http://localhost:3001/api` | STRATO API base URL |
| `STRATO_NODE_URL` | unset | Alternative node base URL. If set and `STRATO_API_BASE_URL` is unset, Griphook appends `/api` automatically. |
| `STRATO_HTTP_TIMEOUT_MS` | `15000` | HTTP request timeout (ms) |

`STRATO_API_BASE_URL` takes precedence over `STRATO_NODE_URL`.

#### HTTP Transport
| Variable | Default | Description |
|----------|---------|-------------|
| `GRIPHOOK_HTTP_ENABLED` | `true` | Enable HTTP transport |
| `GRIPHOOK_HTTP_HOST` | `127.0.0.1` | Bind address |
| `GRIPHOOK_HTTP_PORT` | `3005` | Port |

#### Hosted Mode
| Variable | Description |
|----------|-------------|
| `GRIPHOOK_PUBLIC_URL` | Public URL (enables multi-user auth) |

## Deploying a Hosted Instance

Set `GRIPHOOK_PUBLIC_URL` to enable multi-user deployment with per-request authentication. You'll also need to add the redirect URI `https://<your-domain>/login/callback` to your Keycloak client.

```bash
GRIPHOOK_PUBLIC_URL=https://griphook.testnet.strato.nexus npm start
```

The server exposes `/.well-known/oauth-protected-resource` (RFC 9728). MCP clients with OAuth support authenticate automatically.  
Hosted mode accepts either:
- a user access token (JWT) from an active OAuth session, or
- a refresh token (from `/login`) which the server exchanges for an access token.

See [deployment guide](https://github.com/strato-net/strato-griphook/issues/1) for full setup including Keycloak, DNS, nginx, and SSL configuration.

## Troubleshooting

| Error | Solution |
|-------|----------|
| `OPENID_DISCOVERY_URL ... required` | Set OAuth env vars before `npm run login` |
| `Failed to acquire access token` | Check credentials and discovery URL |
| `403 Forbidden` | Token expired - run `npm run login` again |
| `ECONNREFUSED` | Check `STRATO_API_BASE_URL` points to running instance |

## AI Coding Tool Compatibility

Griphook works with any MCP-enabled AI coding tool. You can either reuse an active OAuth access token, or sign in at `/login` to get a token for tool configuration.

### Supported Tools

| Tool | Config File | Type Field |
|------|-------------|------------|
| **Cursor** | `.cursor/mcp.json` or `~/.cursor/mcp.json` | `http` |
| **Claude Code** | `.mcp.json` or `~/.claude.json` | `http` |
| **Codex** | `~/.codex/config.toml` | `http` |
| **Kilo Code** | `.kilocode/mcp.json` | `streamable-http` |
| **Cline** | `cline_mcp_settings.json` | `streamableHttp` |
| **OpenCode** | `opencode.json` or `~/.config/opencode/opencode.json` | `remote` |
| **VS Code Copilot** | `.vscode/mcp.json` | `http` |

### Example Configurations

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "griphook": {
      "type": "http",
      "url": "https://griphook.strato.nexus/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

**Claude Code** (`.mcp.json` or `~/.claude.json`):
```json
{
  "mcpServers": {
    "griphook": {
      "type": "http",
      "url": "https://griphook.strato.nexus/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):
```toml
[mcp_servers.griphook]
type = "http"
url = "https://griphook.strato.nexus/mcp"

[mcp_servers.griphook.headers]
Authorization = "Bearer <your-token>"
```

**Kilo Code** (`.kilocode/mcp.json`):
```json
{
  "mcpServers": {
    "griphook": {
      "type": "streamable-http",
      "url": "https://griphook.strato.nexus/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

**Cline** (`cline_mcp_settings.json`):
```json
{
  "mcpServers": {
    "griphook": {
      "type": "streamableHttp",
      "url": "https://griphook.strato.nexus/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

**OpenCode** (`opencode.json`):
```json
{
  "mcp": {
    "griphook": {
      "type": "remote",
      "url": "https://griphook.strato.nexus/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

**VS Code Copilot** (`.vscode/mcp.json`):
```json
{
  "servers": {
    "griphook": {
      "type": "http",
      "url": "https://griphook.strato.nexus/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

### Known Issues

- **Cursor**: Tools may appear in the sidebar but not be callable in chat. Try using global config (`~/.cursor/mcp.json`) and restart Cursor.
- **VS Code Copilot**: Requires VS Code 1.102+ with Agent Mode enabled (`chat.agent.enabled`).

## License

[MPL-2.0](LICENSE)

## Security

This tool can move funds and change on-chain state. Treat it accordingly.

- **Credentials** are stored unencrypted at `~/.griphook/credentials.json` (file `0600`, dir `0700`). Protect your filesystem.
- **HTTP transport** binds to `127.0.0.1` without TLS. Keep it local or front with HTTPS + auth if exposed.
- **Report vulnerabilities** privately to maintainers rather than opening public issues.
