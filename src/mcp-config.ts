/**
 * Custom tool discovery and MCP config file generation.
 *
 * Discovers non-built-in tools from pi, writes their schemas to a temp file,
 * and generates an MCP config that points to the schema-only MCP server.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** The 6 built-in pi tools that have Claude Code equivalents.
 *
 * These are handled natively by the extension's event bridge (mapped to Read,
 * Write, Edit, Bash, Grep, Glob). They must NOT be registered as custom MCP
 * tools because Claude Code provides its own definitions for them.
 *
 * Other pi built-in tools (like ls) that lack Claude Code equivalents should
 * be treated as custom tools when activated — they get registered via MCP
 * so Claude Code can call them through the custom-tools bridge. If not
 * activated, getActiveTools() filtering ensures they're excluded. */
const BUILT_IN_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
]);

/** A custom tool definition with MCP-compatible schema. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Get custom tool definitions from pi, filtering out built-in tools and
 * any tools that are not currently active.
 *
 * getAllTools() returns all registered tools regardless of activation status.
 * getActiveTools() returns only the names of currently active tools.
 * We filter by both: built-in tools are excluded (they have Claude Code
 * equivalents), and inactive tools are excluded (they shouldn't be exposed
 * to Claude Code if no extension has activated them).
 *
 * @param pi - The pi ExtensionAPI instance
 * @returns Array of custom tool definitions (empty if all tools are built-in)
 */
export function getCustomToolDefs(pi: any): McpToolDef[] {
  const allTools = pi.getAllTools();

  if (!Array.isArray(allTools)) {
    return [];
  }

  // Get active tool names to filter out deactivated tools.
  // getActiveTools() returns string[] of currently active tool names.
  // Only active tools should be exposed to Claude Code via MCP.
  const activeToolNames = new Set(
    typeof pi.getActiveTools === "function"
      ? pi.getActiveTools()
      : allTools.map((t: any) => t.name),
  );

  return allTools
    .filter((tool: any) => !BUILT_IN_TOOL_NAMES.has(tool.name))
    .filter((tool: any) => activeToolNames.has(tool.name))
    .map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }));
}

/**
 * Write MCP config and tool schemas to temp files.
 *
 * Creates two temp files:
 * 1. Schema file: JSON array of tool definitions
 * 2. Config file: MCP config pointing to the schema-only server
 *
 * @param toolDefs - Array of custom tool definitions
 * @returns Path to the MCP config file
 */
export function writeMcpConfig(toolDefs: McpToolDef[]): string {
  // Write tool schemas to temp file
  const schemaFilePath = join(
    tmpdir(),
    `pi-claude-mcp-schemas-${process.pid}.json`,
  );
  writeFileSync(schemaFilePath, JSON.stringify(toolDefs));

  // Resolve path to the schema server .cjs file (sibling of this module)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const serverPath = join(__dirname, "mcp-schema-server.cjs");

  // Build MCP config
  const config = {
    mcpServers: {
      "custom-tools": {
        command: "node",
        args: [serverPath, schemaFilePath],
      },
    },
  };

  // Write config to temp file
  const configFilePath = join(
    tmpdir(),
    `pi-claude-mcp-config-${process.pid}.json`,
  );
  writeFileSync(configFilePath, JSON.stringify(config));

  return configFilePath;
}
