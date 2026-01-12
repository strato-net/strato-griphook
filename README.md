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

### Environment variables

- **Required for login (`griphook login` / `npm run login`):**
  - `OAUTH_CLIENT_ID`
  - `OAUTH_CLIENT_SECRET`
  - `OPENID_DISCOVERY_URL`
- **Required for the server (`griphook serve` / `npm start`):**
  - `STRATO_API_BASE_URL`
  - Existing credentials file from a prior login (`~/.griphook/credentials.json`)

## Documentation

See [docs/](docs/) for detailed documentation:

- [Setup & Configuration](docs/setup.md)
- [Tools Reference](docs/tools.md)
- [Resources](docs/resources.md)

## License

[MPL-2.0](LICENSE)

## Security

See [SECURITY.md](SECURITY.md) for notes on credential storage and HTTP transport exposure.

## Notes
- Browser login uses PKCE + state validation; rerun `griphook login` if auth fails.
- HTTP transport binds to `127.0.0.1:3005` without TLS; keep it local or front with HTTPS if exposed.
- Credentials are stored unencrypted at `~/.griphook/credentials.json`; protect your filesystem accordingly.
