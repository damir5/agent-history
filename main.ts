#!/usr/bin/env -S deno run -A

import { parseArgs } from "@std/cli/parse-args";
import { ClaudeAdapter } from "./src/adapters/claude.ts";
import { geminiAdapter } from "./src/adapters/gemini.ts";
import { codexAdapter } from "./src/adapters/codex.ts";
import { opencodeAdapter } from "./src/adapters/opencode.ts";
import { parseFilters } from "./src/filters.ts";
import { runRemote } from "./src/remote.ts";
import type { Correction, HistoryAdapter, Message, Session, Stats } from "./src/types.ts";

const VERSION = "0.1.0";

const ALL_ADAPTERS: HistoryAdapter[] = [
  new ClaudeAdapter(),
  geminiAdapter,
  codexAdapter,
  opencodeAdapter,
];

function usage(): string {
  return `agent-history v${VERSION} — query agent conversation history

Usage:
  agent-history <command> [options]

Commands:
  search          Search user messages across agents
  sessions        List sessions across agents
  conversation    Dump a single conversation
  stats           Aggregate statistics
  corrections     Find user corrections/mistakes
  remote          Run command on remote machine

Global Options:
  --agent <name>     Filter by agent (claude|gemini|codex|opencode|all) [default: all]
  --project <glob>   Filter by project path/name
  --from <date>      Start date (ISO or relative: 7d, 1w, 1m)
  --to <date>        End date
  --limit <N>        Max results
  --format <fmt>     Output format (json|jsonl|text) [default: json]
  --help             Show help
  --version          Show version

Search Options:
  --query <regex>    Search pattern (required for search)

Conversation:
  agent-history conversation <agent>:<session-id>

Remote:
  agent-history remote <destination> <command> [args...]
`;
}

async function getAdapters(agentFilter?: string): Promise<HistoryAdapter[]> {
  if (agentFilter && agentFilter !== "all") {
    const adapter = ALL_ADAPTERS.find((a) => a.name === agentFilter);
    if (!adapter) throw new Error(`Unknown agent: ${agentFilter}`);
    if (!(await adapter.available())) {
      console.error(`Warning: ${agentFilter} history not found`);
      return [];
    }
    return [adapter];
  }
  const available: HistoryAdapter[] = [];
  for (const a of ALL_ADAPTERS) {
    if (await a.available()) available.push(a);
  }
  return available;
}

function output(data: unknown, format: string): void {
  if (format === "jsonl") {
    if (Array.isArray(data)) {
      for (const item of data) console.log(JSON.stringify(item));
    } else {
      console.log(JSON.stringify(data));
    }
  } else if (format === "text") {
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === "object" && item !== null) {
          const r = item as Record<string, unknown>;
          // Stats objects
          if ("sessions" in r && "messages" in r) {
            console.log(`[${r.agent}]  sessions: ${r.sessions}  messages: ${r.messages}  tokens: ${r.tokenUsage ?? 0}  projects: ${(r.projects as string[])?.length ?? 0}  models: ${(r.models as string[])?.join(", ") ?? ""}`);
            continue;
          }
          // Session objects
          if ("startTime" in r && "messageCount" in r) {
            console.log(`[${r.agent}]  ${String(r.startTime).slice(0, 19)}  ${r.sessionId}  msgs:${r.messageCount}  ${r.project}  ${r.model ?? ""}`);
            continue;
          }
          // Correction objects
          if ("correction" in r) {
            console.log(`[${r.agent}]  ${String(r.timestamp).slice(0, 19)}  ${r.project}  [${r.reason}]  ${String(r.correction).slice(0, 200)}`);
            continue;
          }
          // Message objects
          const parts: string[] = [];
          if (r.agent) parts.push(`[${r.agent}]`);
          if (r.timestamp) parts.push(String(r.timestamp).slice(0, 19));
          if (r.project) parts.push(String(r.project));
          if (r.text) parts.push(String(r.text).slice(0, 200));
          console.log(parts.join("  "));
        } else {
          console.log(String(item));
        }
      }
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function collectAsync<T>(iter: AsyncIterable<T>, limit?: number): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) {
    results.push(item);
    if (limit && results.length >= limit) break;
  }
  return results;
}

async function safeCollect<T>(name: string, fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    console.error(`Warning: ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function cmdSearch(args: ReturnType<typeof parseArgs>): Promise<void> {
  if (!args.query) {
    console.error("Error: --query is required for search");
    Deno.exit(1);
  }
  const filters = parseFilters(args);
  const adapters = await getAdapters(filters.agent);
  const results: Message[] = [];
  for (const adapter of adapters) {
    const msgs = await safeCollect(adapter.name, () => collectAsync(adapter.search(filters), filters.limit));
    results.push(...msgs);
  }
  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const limited = filters.limit ? results.slice(0, filters.limit) : results;
  output(limited, args.format ?? "json");
}

async function cmdSessions(args: ReturnType<typeof parseArgs>): Promise<void> {
  const filters = parseFilters(args);
  const adapters = await getAdapters(filters.agent);
  const results: Session[] = [];
  for (const adapter of adapters) {
    const sessions = await safeCollect(adapter.name, () => collectAsync(adapter.sessions(filters), filters.limit));
    results.push(...sessions);
  }
  results.sort((a, b) => b.startTime.localeCompare(a.startTime));
  const limited = filters.limit ? results.slice(0, filters.limit) : results;
  output(limited, args.format ?? "json");
}

async function cmdConversation(args: ReturnType<typeof parseArgs>): Promise<void> {
  const ref = args._[1] as string | undefined;
  if (!ref || !ref.includes(":")) {
    console.error("Usage: agent-history conversation <agent>:<session-id>");
    Deno.exit(1);
  }
  const [agentName, sessionId] = ref.split(":", 2);
  const adapter = ALL_ADAPTERS.find((a) => a.name === agentName);
  if (!adapter) {
    console.error(`Unknown agent: ${agentName}. Valid: claude, gemini, codex, opencode`);
    Deno.exit(1);
  }
  const messages = await collectAsync(adapter.conversation(sessionId!));
  output(messages, args.format ?? "json");
}

async function cmdStats(args: ReturnType<typeof parseArgs>): Promise<void> {
  const filters = parseFilters(args);
  const adapters = await getAdapters(filters.agent);
  const results: Stats[] = [];
  for (const adapter of adapters) {
    try {
      results.push(await adapter.stats(filters));
    } catch (err) {
      console.error(`Warning: ${adapter.name} stats failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  output(results, args.format ?? "json");
}

async function cmdCorrections(args: ReturnType<typeof parseArgs>): Promise<void> {
  const filters = parseFilters(args);
  const adapters = await getAdapters(filters.agent);
  const results: Correction[] = [];
  for (const adapter of adapters) {
    const corrections = await safeCollect(adapter.name, () => collectAsync(adapter.corrections(filters), filters.limit));
    results.push(...corrections);
  }
  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const limited = filters.limit ? results.slice(0, filters.limit) : results;
  output(limited, args.format ?? "json");
}

async function cmdRemote(args: ReturnType<typeof parseArgs>): Promise<void> {
  const dest = args._[1] as string | undefined;
  if (!dest) {
    console.error("Usage: agent-history remote <destination> <command> [args...]");
    Deno.exit(1);
  }
  // Pass through remaining args after "remote <dest>"
  const rawArgs = Deno.args;
  const remoteIdx = rawArgs.indexOf("remote");
  const subArgs = rawArgs.slice(remoteIdx + 2); // skip "remote" and destination name
  await runRemote(dest, subArgs);
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    boolean: ["help", "version"],
    string: ["agent", "project", "from", "to", "limit", "query", "format"],
    default: { format: "json" },
    stopEarly: true,
  });

  if (args.help && args._.length === 0) {
    console.log(usage());
    Deno.exit(0);
  }

  if (args.version) {
    console.log(VERSION);
    Deno.exit(0);
  }

  const command = args._[0] as string | undefined;

  // Re-parse with full args for subcommands
  const fullArgs = parseArgs(Deno.args, {
    boolean: ["help", "version"],
    string: ["agent", "project", "from", "to", "limit", "query", "format"],
    default: { format: "json" },
  });

  try {
    switch (command) {
      case "search":
        await cmdSearch(fullArgs);
        break;
      case "sessions":
        await cmdSessions(fullArgs);
        break;
      case "conversation":
        await cmdConversation(fullArgs);
        break;
      case "stats":
        await cmdStats(fullArgs);
        break;
      case "corrections":
        await cmdCorrections(fullArgs);
        break;
      case "remote":
        await cmdRemote(fullArgs);
        break;
      default:
        console.error(command ? `Unknown command: ${command}` : "No command specified");
        console.error("Run 'agent-history --help' for usage");
        Deno.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
