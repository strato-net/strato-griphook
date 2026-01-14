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

```bash
npm install
npm run build
npm run login   # Opens browser for OAuth authentication
npm start       # Start the MCP server
```

Credentials are stored in `~/.griphook/credentials.json`.

## Using with Claude Code

Add to your project's `.mcp.json` or Claude Code settings:

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
        "STRATO_API_BASE_URL": "https://your-strato-instance/api"
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
| `GRIPHOOK_HOSTED_CLIENT_ID` | OAuth client ID for hosted mode |
| `GRIPHOOK_HOSTED_CLIENT_SECRET` | OAuth client secret for hosted mode |

## Hosted Mode

Set `GRIPHOOK_PUBLIC_URL` to enable multi-user deployment with per-request authentication:

```bash
GRIPHOOK_PUBLIC_URL=https://griphook.example.com npm start
```

The server exposes `/.well-known/oauth-protected-resource` (RFC 9728). MCP clients with OAuth support authenticate automatically:

```json
{
  "mcpServers": {
    "griphook": { "url": "https://griphook.example.com/mcp" }
  }
}
```

For clients without OAuth support, use `griphook token` to get a Bearer token.

## Troubleshooting

| Error | Solution |
|-------|----------|
| `OPENID_DISCOVERY_URL ... required` | Set OAuth env vars before `npm run login` |
| `Failed to acquire access token` | Check credentials and discovery URL |
| `403 Forbidden` | Token expired - run `npm run login` again |
| `ECONNREFUSED` | Check `STRATO_API_BASE_URL` points to running instance |

## License

[MPL-2.0](LICENSE)

## Security

This tool can move funds and change on-chain state. Treat it accordingly.

- **Credentials** are stored unencrypted at `~/.griphook/credentials.json` (file `0600`, dir `0700`). Protect your filesystem.
- **HTTP transport** binds to `127.0.0.1` without TLS. Keep it local or front with HTTPS + auth if exposed.
- **Report vulnerabilities** privately to maintainers rather than opening public issues.
