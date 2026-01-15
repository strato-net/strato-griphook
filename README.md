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

A public testnet instance is available (mainnet coming soon).

1. Visit https://griphook-testnet.strato.nexus/login to sign in and get a token
2. Add to your MCP config (e.g., `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "griphook": {
      "type": "http",
      "url": "https://griphook-testnet.strato.nexus/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

See [AI Coding Tool Compatibility](#ai-coding-tool-compatibility) for tool-specific configurations.

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

#### Required for Server
| Variable | Default | Description |
|----------|---------|-------------|
| `STRATO_API_BASE_URL` | `http://localhost:3001/api` | STRATO API base URL |
| `STRATO_HTTP_TIMEOUT_MS` | `15000` | HTTP request timeout (ms) |

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
GRIPHOOK_PUBLIC_URL=https://griphook-testnet.strato.nexus npm start
```

The server exposes `/.well-known/oauth-protected-resource` (RFC 9728). MCP clients with OAuth support authenticate automatically. For clients without OAuth support, visit `/login` to get a Bearer token.

See [deployment guide](https://github.com/strato-net/strato-griphook/issues/1) for full setup including Keycloak, DNS, nginx, and SSL configuration.

## Troubleshooting

| Error | Solution |
|-------|----------|
| `OPENID_DISCOVERY_URL ... required` | Set OAuth env vars before `npm run login` |
| `Failed to acquire access token` | Check credentials and discovery URL |
| `403 Forbidden` | Token expired - run `npm run login` again |
| `ECONNREFUSED` | Check `STRATO_API_BASE_URL` points to running instance |

## AI Coding Tool Compatibility

Griphook works with any MCP-enabled AI coding tool. All tools use the same authentication flow: sign in at `/login` to get a token, then add it to your tool's config.

### Supported Tools

| Tool | Config File | Type Field |
|------|-------------|------------|
| **Claude Code** | `.mcp.json` or `~/.claude.json` | `http` |
| **Cursor** | `.cursor/mcp.json` or `~/.cursor/mcp.json` | `http` |
| **VS Code Copilot** | `.vscode/mcp.json` | `http` |
| **Cline** | `cline_mcp_settings.json` | `streamableHttp` |
| **OpenCode** | `opencode.json` or `~/.config/opencode/opencode.json` | `remote` |
| **Kilo Code** | `.kilocode/mcp.json` | `streamable-http` |
| **Codex** | `~/.codex/config.toml` | `http` |

### Example Configurations

**Claude Code / Cursor / VS Code Copilot** (`.mcp.json`):
```json
{
  "mcpServers": {
    "griphook": {
      "type": "http",
      "url": "https://griphook-testnet.strato.nexus/mcp",
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
      "url": "https://griphook-testnet.strato.nexus/mcp",
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
      "url": "https://griphook-testnet.strato.nexus/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

**Kilo Code** (`.kilocode/mcp.json`):
```json
{
  "mcpServers": {
    "griphook": {
      "type": "streamable-http",
      "url": "https://griphook-testnet.strato.nexus/mcp",
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
url = "https://griphook-testnet.strato.nexus/mcp"

[mcp_servers.griphook.headers]
Authorization = "Bearer <your-token>"
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
