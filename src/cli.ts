#!/usr/bin/env node
import "dotenv/config";
import { loginCommand, logoutCommand, statusCommand, tokenCommand, getCredentialsPath } from "./login.js";
import { runToolsListCommand, runToolDescribeCommand, runToolByName } from "./mcpCli.js";

const args = process.argv.slice(2);
const command = args[0];

function printUsage(): void {
  console.log(`
Griphook - MCP server for STRATO

Usage:
  griphook <command>
  griphook <tool-name> [--<input-name> <value> | --input '{...}']

Commands:
  login     Authenticate with BlockApps via browser
  logout    Clear stored credentials
  status    Show current authentication status
  token     Print Bearer token for MCP client configuration
  serve     Start the MCP server (default)
  tools     List available MCP tools
  help      Show this help message

Authentication:
  Run 'griphook login' to authenticate via browser OAuth.
  Credentials are stored in: ${getCredentialsPath()}

Tool CLI (same API surface as MCP tools):
  griphook tools                    List all tools
  griphook tools <tool-name>        Show tool inputs
  griphook <tool-name> --<input-name> <value>  Call a tool directly

Token for remote MCP servers:
  Run 'griphook token' to get a Bearer token for configuring
  MCP clients that don't support OAuth (e.g., Cursor, Cline).

For MCP server configuration, see the documentation.
`);
}

async function main(): Promise<void> {
  switch (command) {
    case "login":
      await loginCommand();
      break;

    case "logout":
      logoutCommand();
      break;

    case "status":
      statusCommand();
      break;

    case "token":
      await tokenCommand(args.includes("--json"));
      break;

    case "serve":
    case undefined:
      // Start MCP server - dynamic import to avoid loading everything for CLI commands
      const { start } = await import("./server.js");
      await start();
      break;

    case "tools": {
      const toolArg = args[1];
      if (toolArg && !toolArg.startsWith("--")) {
        const described = await runToolDescribeCommand(toolArg);
        if (!described) {
          console.error(`Unknown tool: ${toolArg}`);
          process.exit(1);
        }
      } else {
        await runToolsListCommand(args.slice(1));
      }
      break;
    }

    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;

    default: {
      if (command) {
        const handled = await runToolByName(command, args.slice(1));
        if (handled) {
          break;
        }
      }

      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
