/**
 * Prompt builder for flattening pi conversation history into a labeled text prompt.
 *
 * Follows the reference project's buildPromptBlocks() pattern:
 * - USER: / ASSISTANT: / TOOL RESULT: labels
 * - Content blocks serialized by type
 * - Images in the final user message are translated to Anthropic API format (HIST-02)
 * - Images in non-final messages get placeholder text with console.warn
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  mapPiToolNameToClaude,
  translatePiArgsToClaude,
  isCustomToolName,
} from "./tool-mapping.js";

/**
 * Anthropic API content block types for image passthrough.
 * Used when the final user message contains images that need to be
 * translated from pi-ai format to Anthropic format.
 */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

// We use `any` for Context to avoid requiring @mariozechner/pi-ai at dev time.
// At runtime, pi provides the real Context type.

/**
 * Flattens a pi conversation context's messages array into a labeled text prompt
 * suitable for sending to the Claude CLI subprocess.
 *
 * Each message is labeled with its role:
 * - USER: for user messages
 * - ASSISTANT: for assistant messages
 * - TOOL RESULT (historical {toolName}): for tool result messages
 */
/** Module-level counter for placeholder images, reset per buildPrompt call. */
let placeholderImageCount = 0;

/**
 * Translate a pi-ai image block to Anthropic API format.
 * Returns null if the block is missing required data/mimeType fields.
 *
 * pi-ai format:  { type: "image", data: string (base64), mimeType: string }
 * Anthropic format: { type: "image", source: { type: "base64", media_type: string, data: string } }
 */
function translateImageBlock(piBlock: any): AnthropicContentBlock | null {
  if (piBlock.data && piBlock.mimeType) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: piBlock.mimeType,
        data: piBlock.data,
      },
    };
  }
  return null; // Invalid image block, will fall back to placeholder
}

/**
 * Build content blocks for the final user message, translating images
 * from pi-ai format to Anthropic API format.
 *
 * @returns Array of AnthropicContentBlock with text and translated images
 */
function buildFinalUserContent(
  content: string | any[],
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text ?? "" });
    } else if (block.type === "image") {
      const translated = translateImageBlock(block);
      if (translated) {
        blocks.push(translated);
      } else {
        // Invalid image block: fall back to placeholder text
        blocks.push({
          type: "text",
          text: "[An image was shared here but could not be included]",
        });
        placeholderImageCount++;
      }
    }
    // Unknown block types silently skipped
  }
  return blocks;
}

/**
 * Check if a message content array contains image blocks.
 */
function contentHasImages(content: string | any[]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false;
  return content.some((block) => block.type === "image");
}

/**
 * Check if the conversation ends with a custom tool result.
 * If so, build a simplified prompt that presents the result directly
 * instead of replaying the full conversation history with tool labels.
 */
function buildCustomToolResultPrompt(messages: any[]): string | null {
  if (messages.length < 3) return null;

  const last = messages[messages.length - 1];
  if (last.role !== "toolResult") return null;
  if (!last.toolName || !isCustomToolName(last.toolName)) return null;

  // Find the original user message (scan backwards past assistant + toolResult)
  let userMessage: string | null = null;
  for (let i = messages.length - 3; i >= 0; i--) {
    if (messages[i].role === "user") {
      userMessage = userContentToText(messages[i].content);
      break;
    }
  }
  if (!userMessage) return null;

  const toolResult = toolResultContentToText(last.content);
  return `${userMessage}\n\n[The ${last.toolName} tool was called and returned the following result]\n${toolResult}\n\nRespond to the user using the tool result above.`;
}

/**
 * Build a prompt for a resumed session.
 *
 * When resuming via --resume, the CLI already has the full conversation history.
 * We only need to send the new content since the last turn: the last assistant
 * response's tool results (if any) followed by the latest user message.
 *
 * For tool_use flows: pi sends [user, assistant(toolCall), toolResult, ...]
 * We need to include tool results so the resumed session sees them, plus the
 * final user message.
 *
 * Falls back to full prompt if the message structure is unexpected.
 */
export function buildResumePrompt(context: {
  messages: any[];
}): string | AnthropicContentBlock[] {
  const messages = context.messages;
  if (messages.length === 0) return "";

  // Find the last user message
  const finalUserIndex = findFinalUserMessageIndex(messages);
  if (finalUserIndex < 0) return "";

  // Collect new messages: everything from the last assistant turn onwards
  // (tool results from the last assistant + the new user message)
  const newMessages: any[] = [];

  // Walk backwards from finalUserIndex to find where new content starts.
  // Include trailing toolResult messages that follow the last assistant turn.
  let startIdx = finalUserIndex;
  for (let i = finalUserIndex - 1; i >= 0; i--) {
    if (messages[i].role === "toolResult") {
      startIdx = i;
    } else {
      break;
    }
  }

  for (let i = startIdx; i < messages.length; i++) {
    newMessages.push(messages[i]);
  }

  // If there are only tool results + one user message, build a combined prompt
  const parts: string[] = [];
  for (const msg of newMessages) {
    if (msg.role === "toolResult") {
      if (msg.toolName && isCustomToolName(msg.toolName)) {
        parts.push(`TOOL RESULT (${msg.toolName}):`);
      } else {
        const claudeToolName = msg.toolName
          ? mapPiToolNameToClaude(msg.toolName)
          : "unknown";
        parts.push(`TOOL RESULT (historical ${claudeToolName}):`);
      }
      parts.push(toolResultContentToText(msg.content));
    } else if (msg.role === "user") {
      // Check for images in the final user message
      if (contentHasImages(msg.content)) {
        const textSoFar = parts.join("\n");
        const userContent = buildFinalUserContent(msg.content);
        const result: AnthropicContentBlock[] = [];
        if (textSoFar) {
          result.push({ type: "text", text: textSoFar });
        }
        result.push(...userContent);
        return result;
      }
      parts.push(userContentToText(msg.content));
    }
  }

  return parts.join("\n") || "";
}

export function buildPrompt(context: {
  messages: any[];
}): string | AnthropicContentBlock[] {
  // Reset placeholder counter for each call
  placeholderImageCount = 0;

  // Special case: when conversation ends with a custom tool result,
  // present it directly instead of complex history replay
  const customToolPrompt = buildCustomToolResultPrompt(context.messages);
  if (customToolPrompt) {
    // customToolPrompt calls userContentToText which may increment placeholderImageCount
    if (placeholderImageCount > 0) {
      console.warn(
        `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
      );
    }
    return customToolPrompt;
  }

  // Determine if any message has images worth passing through
  const finalUserIndex = findFinalUserMessageIndex(context.messages);
  const finalUserHasImages =
    finalUserIndex >= 0 &&
    contentHasImages(context.messages[finalUserIndex].content);
  const anyToolResultHasImages = context.messages.some(
    (m: any) => m.role === "toolResult" && toolResultHasImages(m.content),
  );

  if (finalUserHasImages || anyToolResultHasImages) {
    // Build history as text (all messages except the final user message)
    const historyParts: string[] = [];
    const toolResultImageBlocks: AnthropicContentBlock[] = [];
    for (let i = 0; i < context.messages.length; i++) {
      if (i === finalUserIndex) continue; // Skip final user message -- handled separately
      const message = context.messages[i];
      if (message.role === "user") {
        historyParts.push("USER:");
        historyParts.push(userContentToText(message.content));
      } else if (message.role === "assistant") {
        historyParts.push("ASSISTANT:");
        historyParts.push(contentToText(message.content));
      } else if (message.role === "toolResult") {
        if (message.toolName && isCustomToolName(message.toolName)) {
          historyParts.push(`TOOL RESULT (${message.toolName}):`);
        } else {
          const claudeToolName = message.toolName
            ? mapPiToolNameToClaude(message.toolName)
            : "unknown";
          historyParts.push(`TOOL RESULT (historical ${claudeToolName}):`);
        }
        // Extract text portion of tool result
        historyParts.push(toolResultContentToText(message.content));
        // Collect image blocks from tool results for passthrough
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === "image") {
              const translated = translateImageBlock(block);
              if (translated) {
                toolResultImageBlocks.push(translated);
                // Undo the placeholder count from toolResultContentToText since we're passing through
                placeholderImageCount--;
              }
            }
          }
        }
      }
    }

    // Build final user message content blocks
    const finalUserContent =
      finalUserIndex >= 0
        ? buildFinalUserContent(context.messages[finalUserIndex].content)
        : [];

    // Combine: history text + tool result images + final user content blocks
    const result: AnthropicContentBlock[] = [];
    const historyText = historyParts.join("\n");
    if (historyText) {
      result.push({ type: "text", text: historyText });
    }
    // Insert tool result images after history text (Claude sees them in context)
    result.push(...toolResultImageBlocks);
    result.push(...finalUserContent);

    if (placeholderImageCount > 0) {
      console.warn(
        `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
      );
    }

    return result;
  }

  // No images in final user message: standard text-only path
  const parts: string[] = [];

  for (const message of context.messages) {
    if (message.role === "user") {
      parts.push("USER:");
      parts.push(userContentToText(message.content));
    } else if (message.role === "assistant") {
      parts.push("ASSISTANT:");
      parts.push(contentToText(message.content));
    } else if (message.role === "toolResult") {
      if (message.toolName && isCustomToolName(message.toolName)) {
        // Custom tools: don't reference MCP tool name. Present result plainly.
        parts.push(`TOOL RESULT (${message.toolName}):`);
      } else {
        const claudeToolName = message.toolName
          ? mapPiToolNameToClaude(message.toolName)
          : "unknown";
        parts.push(`TOOL RESULT (historical ${claudeToolName}):`);
      }
      parts.push(toolResultContentToText(message.content));
    }
  }

  if (placeholderImageCount > 0) {
    console.warn(
      `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
    );
  }

  return parts.join("\n") || "";
}

/**
 * Find the index of the last user message in the messages array.
 * Returns -1 if no user message found.
 */
function findFinalUserMessageIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/**
 * Claude Code tool names and key parameters, replacing pi's tool-specific sections.
 *
 * When using --system-prompt to replace Claude Code's default prompt, the LLM
 * sees tool definitions from the API (Read, Write, Edit, Bash, Grep, Glob)
 * but NOT behavioral guidance about when/how to use them. This replacement
 * section provides that guidance using correct Claude Code tool names and
 * parameter names, so the LLM gets proper usage instructions that match
 * the actual tool schemas.
 */
const CLAUDE_CODE_TOOLS_SECTION = `
Available tools:
- Read: Read file contents (key param: file_path)
- Write: Create or overwrite files (key params: file_path, content)
- Edit: Make precise edits with exact text replacement (key params: file_path, old_string, new_string)
- Bash: Execute bash commands (key param: command)
- Grep: Search file contents for patterns (key params: pattern, path)
- Glob: Find files by glob pattern (key params: pattern, path)

You also have access to custom project tools registered via MCP.

Guidelines:
- Prefer Grep and Glob over Bash for file exploration (faster, respects .gitignore)
- Use Read to examine files before editing
- Use Edit for precise changes (old_string must match exactly)
- Use Write only for new files or complete rewrites
- When summarizing your actions, output plain text directly - do NOT use Bash to display what you did
- Be concise in your responses
- Show file paths clearly when working with files`.trim();

/**
 * Replace pi's tool-specific sections ("Available tools:" through "Guidelines:")
 * in the system prompt with Claude Code–correct equivalents.
 *
 * Pi's system prompt includes tool descriptions and guidelines that use pi's
 * lowercase tool names (read, edit, grep, find, ls) and parameter names
 * (path, oldText, newText). When routed through Claude Code, the LLM sees
 * different tool schemas: PascalCase names (Read, Edit, Grep, Glob) and
 * different parameter names (file_path, old_string, new_string). The pi
 * sections are actively misleading in that context. This function strips them
 * and replaces them with a section that matches Claude Code's actual tools.
 *
 * If the expected sections are not found (e.g., pi changes its format),
 * the original prompt is returned unchanged — worst case is a slightly
 * misleading prompt, not a crash.
 */
function replacePiToolSections(systemPrompt: string): string {
  // Split into double-newline-separated blocks
  const blocks = systemPrompt.split("\n\n");

  // Find the indices of the tool-specific sections
  const availableToolsIdx = blocks.findIndex((block) =>
    block.startsWith("Available tools:\n"),
  );
  const guidelinesIdx = blocks.findIndex((block) =>
    block.startsWith("Guidelines:\n"),
  );

  // If we can't find both sections, return the prompt unchanged
  if (availableToolsIdx === -1 || guidelinesIdx === -1) {
    return systemPrompt;
  }

  // Remove blocks from "Available tools:" through "Guidelines:" (inclusive)
  // This also removes the "In addition to the tools above" line between them
  const filtered = blocks.filter(
    (_, idx) => idx < availableToolsIdx || idx > guidelinesIdx,
  );

  // Insert the Claude Code replacement after the intro paragraph
  // (which is the first block)
  if (filtered.length > 0) {
    filtered.splice(1, 0, CLAUDE_CODE_TOOLS_SECTION);
  } else {
    filtered.push(CLAUDE_CODE_TOOLS_SECTION);
  }

  return filtered.join("\n\n");
}

/**
 * Builds the system prompt from the context's systemPrompt field,
 * replacing pi's tool sections with Claude Code equivalents,
 * then appending AGENTS.md content if found.
 * Sanitizes .pi references to .claude for Claude Code compatibility.
 */
export function buildSystemPrompt(
  context: { systemPrompt?: string; messages: any[] },
  cwd: string,
): string {
  const parts: string[] = [];

  if (context.systemPrompt) {
    // Replace pi's tool-specific sections with Claude Code equivalents
    // before passing the system prompt through to the subprocess.
    // Pi uses lowercase names (read, grep, find, ls) and different parameter
    // names (path, oldText, newText) that don't match Claude Code's tools
    // (Read, Edit, Grep, Glob with file_path, old_string, new_string).
    parts.push(replacePiToolSections(context.systemPrompt));
  }

  // Look for AGENTS.md
  const agentsPath = resolveAgentsMdPath(cwd);
  if (agentsPath) {
    try {
      const content = readFileSync(agentsPath, "utf-8");
      const sanitized = sanitizeAgentsContent(content);
      parts.push(sanitized);
    } catch {
      // If we can't read it, skip silently
    }
  }

  // When conversation history has tool results, instruct Claude to use them
  // instead of trying to re-call tools (which may not be available).
  if (context.messages?.some((m: any) => m.role === "toolResult")) {
    parts.push(
      "IMPORTANT: The conversation history below contains tool results from previously executed tools. " +
        "Use these results to answer the user's question. Do NOT attempt to re-call tools that already have results.",
    );
  }

  return parts.join("\n\n");
}

/**
 * Converts user message content to text.
 * Handles string content and array of content blocks.
 * Image blocks are replaced with placeholder text (HIST-02).
 * Increments the module-level placeholderImageCount for each image.
 */
function userContentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text ?? "");
    } else if (block.type === "image") {
      texts.push("[An image was shared here but could not be included]");
      placeholderImageCount++;
    }
    // Unknown block types silently skipped
  }
  return texts.join("\n");
}

/**
 * Converts assistant message content to text.
 * Handles string content and array of content blocks (text, thinking, toolCall).
 */
function contentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "thinking") return ""; // Skip thinking — internal reasoning, not conversation
      if (block.type === "toolCall") {
        const isCustom = isCustomToolName(block.name);
        if (isCustom) {
          // Custom tools: don't reference the MCP tool name — Claude might try to re-call it.
          // Just note what was done. The result follows as a TOOL RESULT message.
          const argsStr = block.arguments
            ? JSON.stringify(block.arguments)
            : "{}";
          return `[Used ${block.name} tool with args: ${argsStr}]`;
        }
        const claudeName = mapPiToolNameToClaude(block.name);
        const claudeArgs =
          block.arguments && typeof block.arguments === "object"
            ? translatePiArgsToClaude(
                block.name,
                block.arguments as Record<string, unknown>,
              )
            : block.arguments;
        const argsStr = claudeArgs ? JSON.stringify(claudeArgs) : "{}";
        return `Historical tool call (non-executable): ${claudeName} args=${argsStr}`;
      }
      // Unknown block types are represented as a placeholder
      return `[${block.type}]`;
    })
    .join("\n");
}

/**
 * Converts tool result content to text.
 * Handles string content and array of content blocks.
 * Image blocks get placeholder text (actual image passthrough handled separately).
 */
function toolResultContentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text ?? "");
    } else if (block.type === "image") {
      texts.push("[An image was shared here but could not be included]");
      placeholderImageCount++;
    }
  }
  return texts.join("\n");
}

/**
 * Check if a tool result content array contains image blocks.
 */
function toolResultHasImages(content: string | any[]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false;
  return content.some((block) => block.type === "image");
}

/**
 * Walk up from cwd looking for AGENTS.md, fall back to ~/.pi/agent/AGENTS.md.
 */
function resolveAgentsMdPath(cwd: string): string | undefined {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, "AGENTS.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Fall back to global path
  const globalPath = join(homedir(), ".pi", "agent", "AGENTS.md");
  if (existsSync(globalPath)) return globalPath;

  return undefined;
}

/**
 * Sanitize .pi references to .claude in AGENTS.md content
 * for Claude Code compatibility.
 */
function sanitizeAgentsContent(content: string): string {
  let sanitized = content;
  // ~/.pi -> ~/.claude
  sanitized = sanitized.replace(/~\/\.pi\b/gi, "~/.claude");
  // .pi/ -> .claude/ (at word boundary or after whitespace/quotes)
  sanitized = sanitized.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/");
  // Remaining standalone .pi references
  sanitized = sanitized.replace(/\b\.pi\b/gi, ".claude");
  return sanitized;
}
