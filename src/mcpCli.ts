import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { GriphookClient } from "./client.js";
import { GriphookConfig, loadConfig } from "./config.js";
import { loadCredentials } from "./login.js";
import { registerTools } from "./tools.js";

type ToolRegistration = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: z.ZodTypeAny;
  handler: (input: unknown) => Promise<CallToolResult>;
};

export type ParsedToolCall = {
  input: Record<string, unknown>;
  jsonOutput: boolean;
};

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;

  while (true) {
    const asAny = current as unknown as {
      unwrap?: () => z.ZodTypeAny;
      _def?: { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
    };

    if (typeof asAny.unwrap === "function") {
      const next = asAny.unwrap();
      if (next === current) return current;
      current = next;
      continue;
    }

    if (asAny._def?.innerType) {
      current = asAny._def.innerType;
      continue;
    }

    if (asAny._def?.schema) {
      current = asAny._def.schema;
      continue;
    }

    return current;
  }
}

function getObjectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  const unwrapped = unwrapSchema(schema);
  if (!(unwrapped instanceof z.ZodObject)) return null;

  const shape = (unwrapped as unknown as { shape: Record<string, z.ZodTypeAny> | (() => Record<string, z.ZodTypeAny>) }).shape;
  return typeof shape === "function" ? shape() : shape;
}

function isBooleanSchema(schema: z.ZodTypeAny): boolean {
  return unwrapSchema(schema) instanceof z.ZodBoolean;
}

function parseBooleanValue(raw: string): boolean {
  const lowered = raw.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lowered)) return true;
  if (["false", "0", "no", "off"].includes(lowered)) return false;
  throw new Error(`Invalid boolean value '${raw}'. Expected true/false.`);
}

function parseNumberValue(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number value '${raw}'.`);
  }
  return parsed;
}

function parseJsonIfPossible(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return raw;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function coerceToSchema(schema: z.ZodTypeAny, value: unknown): unknown {
  const unwrapped = unwrapSchema(schema);

  if (unwrapped instanceof z.ZodBoolean) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return parseBooleanValue(value);
    return value;
  }

  if (unwrapped instanceof z.ZodNumber) {
    if (typeof value === "number") return value;
    if (typeof value === "string") return parseNumberValue(value);
    return value;
  }

  if (unwrapped instanceof z.ZodString) {
    if (typeof value === "string") return value;
    return String(value);
  }

  if (unwrapped instanceof z.ZodArray) {
    const element = (unwrapped as unknown as { element: z.ZodTypeAny }).element;
    let values: unknown[];

    if (Array.isArray(value)) {
      values = value;
    } else if (typeof value === "string") {
      const parsed = parseJsonIfPossible(value);
      if (Array.isArray(parsed)) {
        values = parsed;
      } else {
        values = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
      }
    } else {
      values = [value];
    }

    return values.map((entry) => coerceToSchema(element, entry));
  }

  if (unwrapped instanceof z.ZodObject || unwrapped instanceof z.ZodRecord) {
    if (typeof value === "string") {
      const parsed = parseJsonIfPossible(value);
      return parsed;
    }
    return value;
  }

  return value;
}

function coerceInput(schema: z.ZodTypeAny, rawInput: Record<string, unknown>): Record<string, unknown> {
  const shape = getObjectShape(schema);
  if (!shape) return rawInput;

  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawInput)) {
    const fieldSchema = shape[key];
    coerced[key] = fieldSchema ? coerceToSchema(fieldSchema, value) : value;
  }

  return coerced;
}

export function parseToolArgs(argv: string[], inputSchema: z.ZodTypeAny): ParsedToolCall {
  const rawInput: Record<string, unknown> = {};
  let jsonOutput = false;
  let jsonInput: Record<string, unknown> | null = null;
  const shape = getObjectShape(inputSchema);
  const shapeOrEmpty = shape ?? {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }

    if (arg === "--input") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("Missing JSON value after --input.");
      }
      i += 1;
      try {
        const parsed = JSON.parse(next) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("--input must be a JSON object.");
        }
        jsonInput = parsed as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Invalid --input JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    if (arg.startsWith("--input=")) {
      const payload = arg.slice("--input=".length);
      try {
        const parsed = JSON.parse(payload) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("--input must be a JSON object.");
        }
        jsonInput = parsed as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Invalid --input JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument '${arg}'. Use --<input-name> <value> or --input '{...}'.`);
    }

    if (arg.startsWith("--no-")) {
      const key = arg.slice(5);
      if (shape && !Object.prototype.hasOwnProperty.call(shape, key)) {
        throw new Error(`Unknown option '--no-${key}'.`);
      }
      const fieldSchema = shapeOrEmpty[key];
      if (!fieldSchema) {
        throw new Error(`Option '--no-${key}' requires a boolean input schema.`);
      }
      if (!isBooleanSchema(fieldSchema)) {
        throw new Error(`Option '--no-${key}' is only valid for boolean inputs.`);
      }
      rawInput[key] = false;
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    let key: string;
    let value: unknown;

    if (equalsIndex !== -1) {
      key = arg.slice(2, equalsIndex);
      value = arg.slice(equalsIndex + 1);
      if (shape && !Object.prototype.hasOwnProperty.call(shape, key)) {
        throw new Error(`Unknown option '--${key}'.`);
      }
    } else {
      key = arg.slice(2);
      if (shape && !Object.prototype.hasOwnProperty.call(shape, key)) {
        throw new Error(`Unknown option '--${key}'.`);
      }
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        const fieldSchema = shapeOrEmpty[key];
        if (!fieldSchema) {
          throw new Error(`Missing value for '--${key}'. Use --${key} <value>.`);
        }
        if (!isBooleanSchema(fieldSchema)) {
          throw new Error(`Missing value for '--${key}'. Use --${key} <value>.`);
        }
        value = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(rawInput, key)) {
      const existing = rawInput[key];
      rawInput[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      rawInput[key] = value;
    }
  }

  const mergedInput = {
    ...(jsonInput ?? {}),
    ...rawInput,
  };

  return {
    input: coerceInput(inputSchema, mergedInput),
    jsonOutput,
  };
}

function getSchemaTypeLabel(schema: z.ZodTypeAny): string {
  const unwrapped = unwrapSchema(schema);

  if (unwrapped instanceof z.ZodString) return "string";
  if (unwrapped instanceof z.ZodNumber) return "number";
  if (unwrapped instanceof z.ZodBoolean) return "boolean";
  if (unwrapped instanceof z.ZodArray) {
    const element = (unwrapped as unknown as { element: z.ZodTypeAny }).element;
    return `array<${getSchemaTypeLabel(element)}>`;
  }
  if (unwrapped instanceof z.ZodEnum) {
    return `enum<${(unwrapped as unknown as { options: string[] }).options.join("|")}>`;
  }
  if (unwrapped instanceof z.ZodRecord) return "object";
  if (unwrapped instanceof z.ZodObject) return "object";

  return "value";
}

function printToolHelp(tool: ToolRegistration): void {
  console.log(`\n${tool.name}`);
  if (tool.title) console.log(`  ${tool.title}`);
  if (tool.description) console.log(`  ${tool.description}`);

  const shape = getObjectShape(tool.inputSchema);
  if (!shape || Object.keys(shape).length === 0) {
    console.log("\nInputs: none");
    console.log(`\nRun: griphook ${tool.name}`);
    return;
  }

  console.log("\nInputs:");
  for (const [key, schema] of Object.entries(shape)) {
    const optional = typeof (schema as unknown as { isOptional?: () => boolean }).isOptional === "function"
      ? (schema as unknown as { isOptional: () => boolean }).isOptional()
      : false;
    const requiredLabel = optional ? "optional" : "required";
    const typeLabel = getSchemaTypeLabel(schema);
    const description = schema.description ? ` - ${schema.description}` : "";
    console.log(`  --${key} <${typeLabel}> (${requiredLabel})${description}`);
  }

  console.log(`\nRun: griphook ${tool.name} --<input-name> <value>`);
  console.log(`Or:  griphook ${tool.name} --input '{"<input-name>":"value"}'`);
}

function printCallResult(result: CallToolResult, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const asAny = result as unknown as {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };

  if (asAny.content && asAny.content.length > 0) {
    for (const entry of asAny.content) {
      if (entry.type === "text" && typeof entry.text === "string") {
        console.log(entry.text);
      } else {
        console.log(JSON.stringify(entry, null, 2));
      }
    }
    return;
  }

  if (typeof asAny.structuredContent !== "undefined") {
    console.log(JSON.stringify(asAny.structuredContent, null, 2));
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

function createToolRegistry(client: GriphookClient, config: GriphookConfig): Map<string, ToolRegistration> {
  const tools = new Map<string, ToolRegistration>();

  const collector = {
    registerTool(name: string, metadata: { title?: string; description?: string; inputSchema: unknown }, handler: (input: unknown) => Promise<CallToolResult>) {
      if (!(metadata.inputSchema instanceof z.ZodType)) {
        throw new Error(`Tool '${name}' has unsupported input schema type.`);
      }

      tools.set(name, {
        name,
        title: metadata.title,
        description: metadata.description,
        inputSchema: metadata.inputSchema,
        handler,
      });
    },
  } as unknown as McpServer;

  registerTools(collector, client, config);
  return tools;
}

function formatToolValidationError(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "input";
    return `- ${path}: ${issue.message}`;
  });
  return ["Input validation failed:", ...lines].join("\n");
}

export async function runToolsListCommand(argv: string[]): Promise<void> {
  const jsonOutput = argv.includes("--json");
  const config = loadConfig();
  const client = new GriphookClient(config);
  const registry = createToolRegistry(client, config);

  const tools = [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (jsonOutput) {
    console.log(JSON.stringify(tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
    })), null, 2));
    return;
  }

  console.log(`Available MCP tools (${tools.length}):`);
  for (const tool of tools) {
    console.log(`  ${tool.name}${tool.title ? ` - ${tool.title}` : ""}`);
  }
  console.log("\nInspect one tool: griphook tools <tool-name>");
  console.log("Call a tool:       griphook <tool-name> --<input-name> <value>");
}

export async function runToolDescribeCommand(toolName: string): Promise<boolean> {
  const config = loadConfig();
  const client = new GriphookClient(config);
  const registry = createToolRegistry(client, config);

  const tool = registry.get(toolName);
  if (!tool) return false;

  printToolHelp(tool);
  return true;
}

export async function runToolByName(toolName: string, argv: string[]): Promise<boolean> {
  const config = loadConfig();
  const client = new GriphookClient(config);
  const registry = createToolRegistry(client, config);

  const tool = registry.get(toolName);
  if (!tool) return false;

  if (argv.includes("--help") || argv.includes("-h")) {
    printToolHelp(tool);
    return true;
  }

  if (!loadCredentials()) {
    throw new Error("Not logged in. Run 'griphook login' to authenticate.");
  }

  const { input, jsonOutput } = parseToolArgs(argv, tool.inputSchema);

  try {
    const validated = tool.inputSchema.parse(input);
    const result = await tool.handler(validated);
    printCallResult(result, jsonOutput);
    return true;
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error(formatToolValidationError(err));
      process.exit(1);
    }
    throw err;
  }
}
