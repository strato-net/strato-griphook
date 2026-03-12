import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { parseToolArgs } from "./mcpCli.js";

const schema = z.object({
  to: z.string(),
  includeBalances: z.boolean().default(false),
});

test("rejects unknown options", () => {
  assert.throws(
    () => parseToolArgs(["--bogus", "x"], schema),
    /Unknown option '--bogus'\./
  );
  assert.throws(
    () => parseToolArgs(["--bogus"], schema),
    /Unknown option '--bogus'\./
  );
});

test("rejects missing value for non-boolean fields", () => {
  assert.throws(
    () => parseToolArgs(["--to"], schema),
    /Missing value for '--to'/
  );
});

test("allows bare boolean flags", () => {
  const parsed = parseToolArgs(["--includeBalances"], schema);
  assert.deepEqual(parsed.input, { includeBalances: true });
  assert.equal(parsed.jsonOutput, false);
});

test("allows --no- for booleans only", () => {
  const parsed = parseToolArgs(["--no-includeBalances"], schema);
  assert.deepEqual(parsed.input, { includeBalances: false });

  assert.throws(
    () => parseToolArgs(["--no-to"], schema),
    /only valid for boolean inputs/
  );
});
