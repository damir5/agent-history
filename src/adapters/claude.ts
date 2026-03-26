import type { Correction, Filters, HistoryAdapter, Message, Session, Stats } from "../types.ts";
import { home, inDateRange, matchProject, msToISO } from "../filters.ts";
import { join } from "@std/path";

// Words that start a corrective user message
const CORRECTION_PREFIXES = /^(no[,. ]|wrong[,. ]|that'?s not|actually[,. ]|i said|don'?t |stop )/i;
const INTERRUPT_TEXT = "[Request interrupted by user]";

// ── raw JSONL shapes ──────────────────────────────────────────────────────────

interface HistoryEntry {
  display: string;
  timestamp: number; // unix ms
  project: string;
  sessionId?: string;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; [k: string]: unknown }
  | { type: "tool_result"; [k: string]: unknown };

interface SessionEntry {
  type: "user" | "assistant" | "progress" | string;
  sessionId: string;
  timestamp: string;
  cwd?: string;
  message?: {
    role: "user" | "assistant";
    content: string | ContentPart[];
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function projectsDir(): string {
  return join(home(), ".claude", "projects");
}

function historyFile(): string {
  return join(home(), ".claude", "history.jsonl");
}

/** Extract plain text from user or assistant message content */
function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** Stream a JSONL file line by line, yielding parsed objects */
async function* streamJsonl<T>(path: string): AsyncGenerator<T> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return;
  }
  const decoder = new TextDecoder();
  const buf = new Uint8Array(65536);
  let leftover = "";
  try {
    while (true) {
      const n = await file.read(buf);
      if (n === null) break;
      const chunk = leftover + decoder.decode(buf.subarray(0, n));
      const lines = chunk.split("\n");
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as T;
        } catch {
          // skip malformed lines
        }
      }
    }
    if (leftover.trim()) {
      try {
        yield JSON.parse(leftover.trim()) as T;
      } catch {
        // skip
      }
    }
  } finally {
    file.close();
  }
}

/**
 * List all session JSONL files under ~/.claude/projects/.
 * Each projects sub-directory may contain UUID.jsonl files.
 * Non-JSONL entries (sessions-index.json, UUID dirs) are skipped.
 */
async function* listSessionFiles(): AsyncGenerator<{ file: string; projectDir: string }> {
  const base = projectsDir();
  for await (const projectEntry of Deno.readDir(base)) {
    if (!projectEntry.isDirectory) continue;
    const projectDir = projectEntry.name;
    const projectPath = join(base, projectDir);
    for await (const fileEntry of Deno.readDir(projectPath)) {
      if (!fileEntry.isFile) continue;
      if (!fileEntry.name.endsWith(".jsonl")) continue;
      yield { file: join(projectPath, fileEntry.name), projectDir };
    }
  }
}

/**
 * Extract the project path from a session file by reading the first entry
 * that has a `cwd` field. Falls back to converting the dir name.
 */
async function resolveProject(file: string, projectDir: string): Promise<string> {
  for await (const entry of streamJsonl<SessionEntry>(file)) {
    if (entry.cwd) return entry.cwd;
  }
  // Fallback: convert "-Users-damir-dev-foo" → "/Users/damir/dev/foo"
  // This is ambiguous for paths containing hyphens, but it's a last resort.
  return projectDir.replace(/^-/, "/").replace(/-/g, "/");
}

// ── adapter ───────────────────────────────────────────────────────────────────

export class ClaudeAdapter implements HistoryAdapter {
  readonly name = "claude" as const;

  async available(): Promise<boolean> {
    try {
      await Deno.stat(historyFile());
      return true;
    } catch {
      return false;
    }
  }

  // Search history.jsonl by display text - fast path, avoids scanning sessions.
  async *search(filters: Filters): AsyncIterable<Message> {
    let count = 0;
    for await (const entry of streamJsonl<HistoryEntry>(historyFile())) {
      if (filters.project && !matchProject(entry.project, filters.project)) continue;
      const ts = msToISO(entry.timestamp);
      if (!inDateRange(ts, filters)) continue;
      if (filters.query && !filters.query.test(entry.display)) continue;
      yield {
        agent: "claude",
        role: "user",
        text: entry.display,
        timestamp: ts,
        sessionId: entry.sessionId ?? "",
        project: entry.project,
      };
      if (filters.limit && ++count >= filters.limit) return;
    }
  }

  // Scan project dirs, build one Session per JSONL file.
  async *sessions(filters: Filters): AsyncIterable<Session> {
    for await (const { file, projectDir } of listSessionFiles()) {
      // Derive sessionId from filename: strip path and .jsonl suffix
      const sessionId = file.split("/").pop()!.replace(/\.jsonl$/, "");

      let project = "";
      let startTime = "";
      let lastTime = "";
      let messageCount = 0;
      let model: string | undefined;

      for await (const entry of streamJsonl<SessionEntry>(file)) {
        if (!project && entry.cwd) project = entry.cwd;

        if (entry.type !== "user" && entry.type !== "assistant") continue;
        if (!entry.message) continue;

        if (!startTime) startTime = entry.timestamp;
        lastTime = entry.timestamp;

        if (entry.type === "assistant" && entry.message.model && !model) {
          model = entry.message.model;
        }

        // Only count real human-typed messages and assistant responses,
        // not tool-result injections (those have array content with tool_result).
        const content = entry.message.content;
        const isToolResult =
          Array.isArray(content) && content.length > 0 && content[0].type === "tool_result";
        if (!isToolResult) messageCount++;
      }

      if (!project) {
        project = projectDir.replace(/^-/, "/").replace(/-/g, "/");
      }

      if (!startTime) continue; // empty file

      if (filters.project && !matchProject(project, filters.project)) continue;
      if (!inDateRange(startTime, filters)) continue;

      yield {
        agent: "claude",
        sessionId,
        project,
        startTime,
        lastTime: lastTime || undefined,
        messageCount,
        model,
      };
    }
  }

  // Return all user/assistant messages from a single session file.
  async *conversation(sessionId: string): AsyncIterable<Message> {
    // Find the file - it could be in any project dir.
    const base = projectsDir();
    let targetFile: string | undefined;

    outer: for await (const projectEntry of Deno.readDir(base)) {
      if (!projectEntry.isDirectory) continue;
      const candidate = join(base, projectEntry.name, `${sessionId}.jsonl`);
      try {
        await Deno.stat(candidate);
        targetFile = candidate;
        break outer;
      } catch {
        // not here, keep looking
      }
    }

    if (!targetFile) return;

    let project = "";
    for await (const entry of streamJsonl<SessionEntry>(targetFile)) {
      if (!project && entry.cwd) project = entry.cwd;
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      if (!entry.message) continue;

      const content = entry.message.content;

      // Skip tool-result injections (user messages that carry tool results)
      const isToolResult =
        Array.isArray(content) && content.length > 0 && content[0].type === "tool_result";
      if (isToolResult) continue;

      const text = extractText(content);
      if (!text) continue;

      const model = entry.type === "assistant" ? entry.message.model : undefined;

      yield {
        agent: "claude",
        role: entry.message.role,
        text,
        timestamp: entry.timestamp,
        sessionId: entry.sessionId,
        project,
        model,
      };
    }
  }

  async stats(filters: Filters): Promise<Stats> {
    const sessionSet = new Set<string>();
    const projectSet = new Set<string>();
    const modelSet = new Set<string>();
    let messages = 0;
    let tokenUsage = 0;

    for await (const { file } of listSessionFiles()) {
      let project = "";
      let counted = false;
      const sessionId = file.split("/").pop()!.replace(/\.jsonl$/, "");

      for await (const entry of streamJsonl<SessionEntry>(file)) {
        if (!project && entry.cwd) project = entry.cwd;
        if (entry.type !== "user" && entry.type !== "assistant") continue;
        if (!entry.message) continue;

        const content = entry.message.content;
        const isToolResult =
          Array.isArray(content) && content.length > 0 && content[0].type === "tool_result";
        if (isToolResult) continue;

        if (!counted) {
          // Apply project/date filter using first message timestamp
          if (filters.project && project && !matchProject(project, filters.project)) break;
          if (!inDateRange(entry.timestamp, filters)) break;
          counted = true;
        }

        messages++;
        if (!sessionSet.has(sessionId)) sessionSet.add(sessionId);
        if (project) projectSet.add(project);

        if (entry.type === "assistant" && entry.message.model) {
          modelSet.add(entry.message.model);
        }
        if (entry.type === "assistant" && entry.message.usage) {
          const u = entry.message.usage;
          tokenUsage += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
        }
      }
    }

    return {
      agent: "claude",
      sessions: sessionSet.size,
      messages,
      projects: [...projectSet],
      tokenUsage: tokenUsage > 0 ? tokenUsage : undefined,
      models: [...modelSet],
    };
  }

  async *corrections(filters: Filters): AsyncIterable<Correction> {
    for await (const { file } of listSessionFiles()) {
      let project = "";

      // Collect all user messages (text only, not tool results) in order
      // so we can look at neighbours.
      interface RawMsg {
        timestamp: string;
        sessionId: string;
        text: string;
        isInterrupt: boolean;
      }

      const msgs: RawMsg[] = [];

      for await (const entry of streamJsonl<SessionEntry>(file)) {
        if (!project && entry.cwd) project = entry.cwd;
        if (entry.type !== "user") continue;
        if (!entry.message) continue;

        const content = entry.message.content;
        const isToolResult =
          Array.isArray(content) && content.length > 0 && content[0].type === "tool_result";
        if (isToolResult) continue;

        const text = extractText(content);
        if (!text) continue;

        msgs.push({
          timestamp: entry.timestamp,
          sessionId: entry.sessionId,
          text,
          isInterrupt: text.trim() === INTERRUPT_TEXT,
        });
      }

      if (!project) continue;
      if (filters.project && !matchProject(project, filters.project)) continue;

      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        if (!inDateRange(msg.timestamp, filters)) continue;

        let reason: Correction["reason"] | null = null;

        if (msg.isInterrupt) {
          // The message AFTER an interrupt is the correction
          const next = msgs[i + 1];
          if (next && !next.isInterrupt) {
            const context = msgs
              .slice(Math.max(0, i - 1), i + 1)
              .filter((m) => !m.isInterrupt)
              .map((m) => m.text);
            yield {
              agent: "claude",
              sessionId: next.sessionId,
              project,
              timestamp: next.timestamp,
              correction: next.text,
              context,
              reason: "interrupt",
            };
            i++; // skip next since we already yielded it
          }
          continue;
        }

        if (CORRECTION_PREFIXES.test(msg.text.trim())) {
          reason = "explicit";
        }

        if (reason) {
          const context = msgs
            .slice(Math.max(0, i - 2), i)
            .filter((m) => !m.isInterrupt)
            .map((m) => m.text);
          yield {
            agent: "claude",
            sessionId: msg.sessionId,
            project,
            timestamp: msg.timestamp,
            correction: msg.text,
            context,
            reason,
          };
        }
      }
    }
  }
}
