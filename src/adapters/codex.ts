import type {
  Correction,
  Filters,
  HistoryAdapter,
  Message,
  Session,
  Stats,
} from "../types.ts";
import { home, inDateRange, matchProject, secToISO } from "../filters.ts";

const AGENT = "codex" as const;

// ---------------------------------------------------------------------------
// SQLite helper
// ---------------------------------------------------------------------------

async function querySqlite(dbPath: string, sql: string): Promise<unknown[]> {
  const cmd = new Deno.Command("sqlite3", {
    args: ["-json", "-readonly", dbPath, sql],
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout, stderr, success } = await cmd.output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
  const text = new TextDecoder().decode(stdout).trim();
  if (!text) return [];
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function codexDir(): string {
  return `${home()}/.codex`;
}

function historyPath(): string {
  return `${codexDir()}/history.jsonl`;
}

function dbPath(): string {
  return `${codexDir()}/state_5.sqlite`;
}

async function* readLines(path: string): AsyncIterable<string> {
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
      const chunk = decoder.decode(buf.subarray(0, n), { stream: true });
      const lines = (leftover + chunk).split("\n");
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) yield line;
      }
    }
    if (leftover.trim()) yield leftover;
  } finally {
    file.close();
  }
}

// ---------------------------------------------------------------------------
// history.jsonl types
// ---------------------------------------------------------------------------

interface HistoryLine {
  session_id: string;
  ts: number; // unix seconds
  text: string;
}

// ---------------------------------------------------------------------------
// Session file event types
// ---------------------------------------------------------------------------

interface SessionMetaEvent {
  type: "session_meta";
  payload: {
    session_id: string;
    ts: string;
    cwd: string;
    cli_version?: string;
    model_provider?: string;
    git?: { branch?: string };
  };
}

interface EventMsgEvent {
  type: "event_msg";
  payload: {
    role: "user" | "assistant";
    content: string;
  };
}

interface ResponseItemEvent {
  type: "response_item";
  payload: {
    role: "assistant";
    content: Array<{ type: string; text?: string }>;
  };
}

interface TurnContextEvent {
  type: "turn_context";
  payload: {
    model?: string;
    approval_policy?: string;
    sandbox_policy?: string;
  };
}

type SessionFileEvent =
  | SessionMetaEvent
  | EventMsgEvent
  | ResponseItemEvent
  | TurnContextEvent
  | { type: string; payload: unknown };

// ---------------------------------------------------------------------------
// SQLite row types
// ---------------------------------------------------------------------------

interface ThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  cwd: string;
  title: string;
  tokens_used: number;
  model: string | null;
  first_user_message: string;
  model_provider: string;
  git_branch: string | null;
  cli_version: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const codexAdapter: HistoryAdapter = {
  name: AGENT,

  async available(): Promise<boolean> {
    try {
      const stat = await Deno.stat(codexDir());
      return stat.isDirectory;
    } catch {
      return false;
    }
  },

  async *search(filters: Filters): AsyncIterable<Message> {
    let count = 0;
    for await (const raw of readLines(historyPath())) {
      let line: HistoryLine;
      try {
        line = JSON.parse(raw) as HistoryLine;
      } catch {
        continue;
      }

      const timestamp = secToISO(line.ts);

      if (!inDateRange(timestamp, filters)) continue;
      if (filters.query && !filters.query.test(line.text)) continue;

      yield {
        agent: AGENT,
        role: "user",
        text: line.text,
        timestamp,
        sessionId: line.session_id,
        project: "",
      };

      count++;
      if (filters.limit && count >= filters.limit) return;
    }
  },

  async *sessions(filters: Filters): AsyncIterable<Session> {
    let rows: ThreadRow[];
    try {
      rows = (await querySqlite(
        dbPath(),
        "SELECT id, rollout_path, created_at, updated_at, cwd, title, tokens_used, model, first_user_message, model_provider, git_branch, cli_version FROM threads ORDER BY created_at DESC",
      )) as ThreadRow[];
    } catch {
      return;
    }

    let count = 0;
    for (const row of rows) {
      const startTime = secToISO(row.created_at);
      const lastTime = secToISO(row.updated_at);
      const project = row.cwd ?? "";

      if (!inDateRange(startTime, filters)) continue;
      if (filters.project && !matchProject(project, filters.project)) continue;

      yield {
        agent: AGENT,
        sessionId: row.id,
        project,
        startTime,
        lastTime,
        messageCount: 0, // not stored in threads table
        model: row.model ?? undefined,
      };

      count++;
      if (filters.limit && count >= filters.limit) return;
    }
  },

  async *conversation(sessionId: string): AsyncIterable<Message> {
    // Look up rollout_path from SQLite
    let rows: ThreadRow[];
    try {
      const escaped = sessionId.replace(/'/g, "''");
      rows = (await querySqlite(
        dbPath(),
        `SELECT id, rollout_path, cwd, model FROM threads WHERE id = '${escaped}'`,
      )) as ThreadRow[];
    } catch {
      return;
    }

    if (!rows.length) return;

    const row = rows[0];
    const rolloutPath = row.rollout_path;
    const project = row.cwd ?? "";
    const model = row.model ?? undefined;

    for await (const raw of readLines(rolloutPath)) {
      let event: SessionFileEvent;
      try {
        event = JSON.parse(raw) as SessionFileEvent;
      } catch {
        continue;
      }

      if (event.type === "event_msg") {
        const e = event as EventMsgEvent;
        if (e.payload.role !== "user" && e.payload.role !== "assistant") {
          continue;
        }
        yield {
          agent: AGENT,
          role: e.payload.role,
          text: e.payload.content,
          timestamp: new Date().toISOString(), // no per-message ts in event_msg
          sessionId,
          project,
          model,
        };
      } else if (event.type === "response_item") {
        const e = event as ResponseItemEvent;
        const parts = e.payload.content
          .filter((c) => c.type === "output_text" && c.text)
          .map((c) => c.text!)
          .join("\n");
        if (parts) {
          yield {
            agent: AGENT,
            role: "assistant",
            text: parts,
            timestamp: new Date().toISOString(),
            sessionId,
            project,
            model,
          };
        }
      } else if (event.type === "session_meta") {
        // no message to emit, but could use ts from payload
      }
    }
  },

  async stats(filters: Filters): Promise<Stats> {
    let totalRows: Array<{ cnt: number; total_tokens: number }>;
    let cwdRows: Array<{ cwd: string }>;
    let modelRows: Array<{ model: string | null }>;

    try {
      totalRows = (await querySqlite(
        dbPath(),
        "SELECT COUNT(*) as cnt, COALESCE(SUM(tokens_used), 0) as total_tokens FROM threads",
      )) as typeof totalRows;

      cwdRows = (await querySqlite(
        dbPath(),
        "SELECT DISTINCT cwd FROM threads WHERE cwd IS NOT NULL AND cwd != ''",
      )) as typeof cwdRows;

      modelRows = (await querySqlite(
        dbPath(),
        "SELECT DISTINCT model FROM threads WHERE model IS NOT NULL AND model != ''",
      )) as typeof modelRows;
    } catch {
      return { agent: AGENT, sessions: 0, messages: 0, projects: [], tokenUsage: 0, models: [] };
    }

    // Apply project filter to project list
    let projects = cwdRows.map((r) => r.cwd);
    if (filters.project) {
      projects = projects.filter((p) => matchProject(p, filters.project!));
    }

    const models = modelRows
      .map((r) => r.model)
      .filter((m): m is string => !!m);

    const total = totalRows[0];

    return {
      agent: AGENT,
      sessions: total?.cnt ?? 0,
      messages: 0, // no per-message count in threads table
      projects,
      tokenUsage: total?.total_tokens ?? 0,
      models,
    };
  },

  async *corrections(filters: Filters): AsyncIterable<Correction> {
    // Explicit correction patterns in user messages
    const explicitPatterns = [
      /\bno[,.]?\s+(that'?s?\s+)?wrong\b/i,
      /\bincorrect\b/i,
      /\bthat'?s?\s+not\s+(right|correct|what\s+i\s+(want|mean|said|asked))\b/i,
      /\bstop\b.*\bdo\s+this\s+instead\b/i,
      /\bactually[,.]?\s+/i,
      /\bno[,.]?\s+instead\b/i,
      /\bwait[,.]?\s+/i,
      /\bundo\b/i,
      /\brevert\b/i,
    ];

    const interruptPatterns = [
      /^(stop|halt|cancel|abort|exit|quit)[.!]?$/i,
      /\bstop\s+(doing|what|that)\b/i,
      /^ctrl.?c$/i,
    ];

    const retryPatterns = [
      /\btry\s+again\b/i,
      /\bretry\b/i,
      /\bone\s+more\s+time\b/i,
      /\bdo\s+it\s+again\b/i,
    ];

    function classifyReason(text: string): "explicit" | "interrupt" | "retry" | null {
      if (interruptPatterns.some((p) => p.test(text))) return "interrupt";
      if (retryPatterns.some((p) => p.test(text))) return "retry";
      if (explicitPatterns.some((p) => p.test(text))) return "explicit";
      return null;
    }

    // Buffer recent messages per session for context
    const sessionContext = new Map<string, string[]>();

    let count = 0;

    for await (const raw of readLines(historyPath())) {
      let line: HistoryLine;
      try {
        line = JSON.parse(raw) as HistoryLine;
      } catch {
        continue;
      }

      const timestamp = secToISO(line.ts);
      if (!inDateRange(timestamp, filters)) {
        continue;
      }

      const ctx = sessionContext.get(line.session_id) ?? [];

      const reason = classifyReason(line.text);
      if (reason) {
        if (!filters.query || filters.query.test(line.text)) {
          yield {
            agent: AGENT,
            sessionId: line.session_id,
            project: "",
            timestamp,
            correction: line.text,
            context: ctx.slice(-3),
            reason,
          };

          count++;
          if (filters.limit && count >= filters.limit) return;
        }
      }

      // Keep last 5 messages as rolling context
      ctx.push(line.text);
      if (ctx.length > 5) ctx.shift();
      sessionContext.set(line.session_id, ctx);
    }
  },
};
