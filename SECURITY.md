## Security Policy / Notes

This repository contains an MCP server that can:

- Read on-chain and DeFi position data
- Execute actions (swaps, lending/borrowing, CDP operations, bridging, admin/governance)

Treat it as a tool that can move funds and change state.

### Credentials storage

Griphook stores OAuth credentials on disk at:

`~/.griphook/credentials.json`

Notes:

- The file is written with permissions `0600` and the directory with `0700`.
- Credentials are **not encrypted**. If you provide a client secret, it is stored alongside access/refresh tokens in plaintext.
- Anyone with read access to this file can potentially act as you.

Recommendations:

- Keep your workstation account secure.
- Do not share the credentials file.
- Consider using OS-level disk encryption and proper user permissions.

### HTTP transport

Griphook can expose an HTTP MCP transport (Streamable HTTP + SSE).

By default it binds to `127.0.0.1` and does **not** use TLS.

Recommendations:

- Keep it **local-only** (`127.0.0.1`) whenever possible.
- If you must expose it beyond localhost, place it behind a reverse proxy that provides:
  - TLS
  - Authentication/authorization
  - Network-level access controls (firewall/VPC)

### Reporting vulnerabilities

If you discover a security issue, please report it privately to the maintainers rather than opening a public issue.
