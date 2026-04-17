/**
 * Pi extension entry point for pi-claude-cli.
 *
 * Registers a custom provider that routes LLM calls through the Claude Code CLI
 * subprocess using stream-json NDJSON protocol.
 */

import { getModels } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { streamViaCli } from "./src/provider.js";
import {
  validateCliPresence,
  validateCliAuth,
  killAllProcesses,
} from "./src/process-manager.js";
import { getCustomToolDefs, writeMcpConfig } from "./src/mcp-config.js";

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", killAllProcesses);

const PROVIDER_ID = "pi-claude-cli";

let mcpConfigPath: string | undefined;
let mcpConfigResolved = false;

/**
 * Lazily generate MCP config on first request (not at load time).
 * pi.getAllTools() fails during extension loading; this defers it
 * until the pi runtime is fully initialized.
 *
 * Only locks (sets mcpConfigResolved) when getAllTools() returns a
 * real array — if it returns undefined/null (registry not ready),
 * we retry on the next request. Once the registry is ready we
 * commit to the result even if there are zero custom tools.
 *
 * Uses warn-don't-block: failure logs a warning but does not
 * prevent the provider from functioning (built-ins still work).
 */
function ensureMcpConfig(pi: ExtensionAPI): string | undefined {
  if (mcpConfigResolved) return mcpConfigPath;
  try {
    const allTools = pi.getAllTools();

    // Registry not ready yet — don't lock, retry on next call
    if (!Array.isArray(allTools)) {
      return mcpConfigPath;
    }

    // Registry is ready — lock regardless of whether custom tools exist
    mcpConfigResolved = true;

    const toolDefs = getCustomToolDefs(pi);
    if (toolDefs.length > 0) {
      mcpConfigPath = writeMcpConfig(toolDefs);
      console.error(
        `[pi-claude-cli] MCP config generated with ${toolDefs.length} custom tool(s)`,
      );
    }
  } catch (err) {
    console.warn(
      "[pi-claude-cli] MCP config generation failed, custom tools unavailable:",
      err,
    );
  }
  return mcpConfigPath;
}

export default function (pi: ExtensionAPI) {
  try {
    // Startup validation
    validateCliPresence(); // throws if CLI not on PATH
    validateCliAuth(); // warns if not authenticated

    const models = getModels("anthropic").map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));



    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "pi-claude-cli",
      apiKey: "unused",
      api: "pi-claude-cli",
      models,
      streamSimple: (model, context, options) => {
        // Activate grep and find on every call. These are off-by-default in pi
        // but Claude Code expects them (via Bash fallbacks). Explicitly naming
        // the tools we need is more future-proof than "all except ls" — if pi
        // adds more off-by-default tools, they won't be silently activated.
        const active = new Set(pi.getActiveTools());
        active.add("grep");
        active.add("find");
        active.delete("ls");
        pi.setActiveTools([...active]);

        const configPath = ensureMcpConfig(pi);
        return streamViaCli(model, context, {
          ...options,
          mcpConfigPath: configPath,
        });
      },
    });
  } catch (err) {
    console.error(`[pi-claude-cli] Failed to register provider:`, err);
  }
}
