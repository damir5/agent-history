import type { Correction, Filters, HistoryAdapter, Message, Session, Stats } from "../types.ts";
import { home, inDateRange, matchProject, msToISO } from "../filters.ts";
import * as path from "jsr:@std/path";

const SQLITE3_BIN = "/usr/bin/sqlite3";
const DB_PATH = () => path.join(home(), ".local", "share", "opencode", "opencode.db");

// ---------------------------------------------------------------------------
// SQLite helper
// ---------------------------------------------------------------------------

async function querySqlite(dbPath: string, sql: string): Promise<unknown[]> {
  const cmd = new Deno.Command(SQLITE3_BIN, {
    args: ["-json", "-readonly", dbPath, `PRAGMA query_only=ON; ${sql}`],
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
// Raw DB row shapes
// ---------------------------------------------------------------------------

interface RawSession {
  id: string;
  directory: string;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
  model?: string | null;
  message_count?: number;
}

interface RawMessage {
  id: string;
  session_id: string;
  time_created: number;
  directory: string;
  data: string; // JSON
  parts: string; // JSON array of part data blobs
}

interface MessageData {
  role: "user" | "assistant";
  modelID?: string;
  tokens?: { input?: number; output?: number };
}

interface PartData {
  type: string;
  text?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(partsJson: string): string {
  let parts: PartData[];
  try {
    parts = JSON.parse(partsJson) as PartData[];
  } catch {
    return "";
  }
  return parts
    .filter((p) => p.type === "text" || p.type === "reasoning")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}

function parseMessageData(raw: string): MessageData {
  try {
    return JSON.parse(raw) as MessageData;
  } catch {
    return { role: "user" };
  }
}

// Build date-range WHERE clause fragment for a unix-ms column.
function dateRangeClause(col: string, filters: Filters): string {
  const parts: string[] = [];
  if (filters.from) parts.push(`${col} >= ${filters.from.getTime()}`);
  if (filters.to) parts.push(`${col} <= ${filters.to.getTime()}`);
  return parts.length ? parts.join(" AND ") : "";
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const opencodeAdapter: HistoryAdapter = {
  name: "opencode",

  async available(): Promise<boolean> {
    try {
      await Deno.stat(DB_PATH());
      return true;
    } catch {
      return false;
    }
  },

  async *search(filters: Filters): AsyncIterable<Message> {
    const db = DB_PATH();
    const dateClause = dateRangeClause("m.time_created", filters);
    const where = ["json_extract(m.data, '$.role') = 'user'", dateClause]
      .filter(Boolean)
      .join(" AND ");

    const sql = `
      SELECT
        m.id,
        m.session_id,
        m.time_created,
        s.directory,
        m.data,
        json_group_array(p.data) AS parts
      FROM message m
      JOIN session s ON s.id = m.session_id
      LEFT JOIN part p ON p.message_id = m.id
      WHERE ${where}
      GROUP BY m.id
      ORDER BY m.time_created DESC
      ${filters.limit ? `LIMIT ${filters.limit * 10}` : ""}
    `;

    const rows = (await querySqlite(db, sql)) as RawMessage[];
    let count = 0;

    for (const row of rows) {
      if (filters.project && !matchProject(row.directory, filters.project)) continue;

      const text = extractText(row.parts);
      if (!text) continue;
      if (filters.query && !filters.query.test(text)) continue;

      const timestamp = msToISO(row.time_created);
      if (!inDateRange(timestamp, filters)) continue;

      yield {
        agent: "opencode",
        role: "user",
        text,
        timestamp,
        sessionId: row.session_id,
        project: row.directory,
      };

      count++;
      if (filters.limit && count >= filters.limit) break;
    }
  },

  async *sessions(filters: Filters): AsyncIterable<Session> {
    const db = DB_PATH();
    const dateClause = dateRangeClause("s.time_created", filters);
    const where = dateClause ? `WHERE ${dateClause}` : "";

    // Get the most-used model per session via a subquery
    const sql = `
      SELECT
        s.id,
        s.directory,
        s.time_created,
        s.time_updated,
        COUNT(m.id) AS message_count,
        (
          SELECT json_extract(m2.data, '$.modelID')
          FROM message m2
          WHERE m2.session_id = s.id
            AND json_extract(m2.data, '$.role') = 'assistant'
            AND json_extract(m2.data, '$.modelID') IS NOT NULL
          ORDER BY m2.time_created DESC
          LIMIT 1
        ) AS model
      FROM session s
      LEFT JOIN message m ON m.session_id = s.id
      ${where}
      GROUP BY s.id
      ORDER BY s.time_created DESC
      ${filters.limit ? `LIMIT ${filters.limit}` : ""}
    `;

    const rows = (await querySqlite(db, sql)) as RawSession[];

    for (const row of rows) {
      if (filters.project && !matchProject(row.directory, filters.project)) continue;

      const startTime = msToISO(row.time_created);
      if (!inDateRange(startTime, filters)) continue;

      const session: Session = {
        agent: "opencode",
        sessionId: row.id,
        project: row.directory,
        startTime,
        lastTime: msToISO(row.time_updated),
        messageCount: row.message_count ?? 0,
      };
      if (row.model) session.model = row.model;
      yield session;
    }
  },

  async *conversation(sessionId: string): AsyncIterable<Message> {
    const db = DB_PATH();

    // Fetch session directory for the project field
    const sessionRows = (await querySqlite(
      db,
      `SELECT directory FROM session WHERE id = '${sessionId.replace(/'/g, "''")}'`,
    )) as Array<{ directory: string }>;
    const project = sessionRows[0]?.directory ?? "";

    const sql = `
      SELECT
        m.id,
        m.session_id,
        m.time_created,
        m.data,
        json_group_array(p.data) AS parts
      FROM message m
      LEFT JOIN part p ON p.message_id = m.id
      WHERE m.session_id = '${sessionId.replace(/'/g, "''")}'
      GROUP BY m.id
      ORDER BY m.time_created ASC
    `;

    const rows = (await querySqlite(db, sql)) as RawMessage[];

    for (const row of rows) {
      const msgData = parseMessageData(row.data);
      const role = msgData.role;
      if (role !== "user" && role !== "assistant") continue;

      let text: string;
      if (role === "assistant") {
        // For assistant messages, text comes from text parts
        text = extractText(row.parts);
      } else {
        text = extractText(row.parts);
      }
      if (!text) continue;

      const msg: Message = {
        agent: "opencode",
        role,
        text,
        timestamp: msToISO(row.time_created),
        sessionId: row.session_id,
        project,
      };
      if (role === "assistant" && msgData.modelID) msg.model = msgData.modelID;
      yield msg;
    }
  },

  async stats(filters: Filters): Promise<Stats> {
    const db = DB_PATH();
    const sessionDateClause = dateRangeClause("s.time_created", filters);
    const sessionWhere = sessionDateClause ? `WHERE ${sessionDateClause}` : "";

    // Sessions count + distinct directories
    const sessionSql = `
      SELECT
        COUNT(*) AS cnt,
        GROUP_CONCAT(DISTINCT s.directory) AS dirs
      FROM session s
      ${sessionWhere}
    `;

    // Messages count
    const msgDateClause = dateRangeClause("m.time_created", filters);
    const msgWhere = msgDateClause ? `AND ${msgDateClause}` : "";

    const msgSql = `
      SELECT
        COUNT(*) AS cnt,
        SUM(
          COALESCE(json_extract(m.data, '$.tokens.input'), 0) +
          COALESCE(json_extract(m.data, '$.tokens.output'), 0)
        ) AS tokens,
        GROUP_CONCAT(DISTINCT json_extract(m.data, '$.modelID')) AS models
      FROM message m
      JOIN session s ON s.id = m.session_id
      WHERE json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(m.data, '$.modelID') IS NOT NULL
        ${msgWhere}
    `;

    const [sessionResult, msgResult] = await Promise.all([
      querySqlite(db, sessionSql) as Promise<Array<{ cnt: number; dirs: string | null }>>,
      querySqlite(db, msgSql) as Promise<Array<{ cnt: number; tokens: number | null; models: string | null }>>,
    ]);

    const sessionRow = sessionResult[0] ?? { cnt: 0, dirs: null };
    const msgRow = msgResult[0] ?? { cnt: 0, tokens: null, models: null };

    let projects = sessionRow.dirs ? sessionRow.dirs.split(",").filter(Boolean) : [];
    if (filters.project) projects = projects.filter((p) => matchProject(p, filters.project!));

    const models = msgRow.models ? msgRow.models.split(",").filter(Boolean) : [];

    const stats: Stats = {
      agent: "opencode",
      sessions: sessionRow.cnt,
      messages: msgRow.cnt,
      projects,
      models,
    };
    if (msgRow.tokens != null && msgRow.tokens > 0) stats.tokenUsage = msgRow.tokens;
    return stats;
  },

  async *corrections(filters: Filters): AsyncIterable<Correction> {
    const db = DB_PATH();
    const dateClause = dateRangeClause("m.time_created", filters);
    const where = ["json_extract(m.data, '$.role') = 'user'", dateClause]
      .filter(Boolean)
      .join(" AND ");

    // Fetch all user messages with their preceding assistant messages for context
    const sql = `
      SELECT
        m.id,
        m.session_id,
        m.time_created,
        s.directory,
        m.data,
        json_group_array(p.data) AS parts
      FROM message m
      JOIN session s ON s.id = m.session_id
      LEFT JOIN part p ON p.message_id = m.id
      WHERE ${where}
      GROUP BY m.id
      ORDER BY m.session_id, m.time_created ASC
    `;

    const rows = (await querySqlite(db, sql)) as RawMessage[];

    // Group by session to detect correction patterns
    const bySession = new Map<string, RawMessage[]>();
    for (const row of rows) {
      const list = bySession.get(row.session_id) ?? [];
      list.push(row);
      bySession.set(row.session_id, list);
    }

    let count = 0;

    for (const [sessionId, msgs] of bySession) {
      if (filters.project) {
        const dir = msgs[0]?.directory ?? "";
        if (!matchProject(dir, filters.project)) continue;
      }

      // Fetch all messages in session ordered by time to get context
      const sessionMsgSql = `
        SELECT m.id, m.time_created, json_extract(m.data, '$.role') AS role,
               json_group_array(p.data) AS parts
        FROM message m
        LEFT JOIN part p ON p.message_id = m.id
        WHERE m.session_id = '${sessionId.replace(/'/g, "''")}'
        GROUP BY m.id
        ORDER BY m.time_created ASC
      `;
      const allMsgs = (await querySqlite(db, sessionMsgSql)) as Array<{
        id: string;
        time_created: number;
        role: string;
        parts: string;
      }>;

      const textMap = new Map<string, string>();
      for (const m of allMsgs) {
        textMap.set(m.id, extractText(m.parts));
      }

      for (const userMsg of msgs) {
        const timestamp = msToISO(userMsg.time_created);
        if (!inDateRange(timestamp, filters)) continue;

        const text = extractText(userMsg.parts);
        if (!text) continue;

        const reason = detectCorrectionReason(text);
        if (!reason) continue;

        if (filters.query && !filters.query.test(text)) continue;

        // Build context: up to 3 preceding messages
        const idx = allMsgs.findIndex((m) => m.id === userMsg.id);
        const contextMsgs = allMsgs.slice(Math.max(0, idx - 3), idx);
        const context = contextMsgs.map((m) => textMap.get(m.id) ?? "").filter(Boolean);

        yield {
          agent: "opencode",
          sessionId,
          project: userMsg.directory,
          timestamp,
          correction: text,
          context,
          reason,
        };

        count++;
        if (filters.limit && count >= filters.limit) break;
      }
      if (filters.limit && count >= filters.limit) break;
    }
  },
};

// ---------------------------------------------------------------------------
// Correction heuristics
// ---------------------------------------------------------------------------

const EXPLICIT_PATTERNS = [
  /\bno[,.]?\s+(that'?s?\s+)?wrong\b/i,
  /\bthat'?s?\s+(not|incorrect|wrong)\b/i,
  /\bplease\s+(undo|revert|go back|don'?t)\b/i,
  /\bactually[,\s]/i,
  /\bwait[,\s]/i,
  /\bstop\b/i,
  /\bundo\b/i,
  /\brevert\b/i,
];

const RETRY_PATTERNS = [
  /\btry\s+again\b/i,
  /\bretry\b/i,
  /\bone\s+more\s+time\b/i,
  /\bagain\b/i,
];

const INTERRUPT_PATTERNS = [
  /^(stop|halt|cancel|abort|pause|wait)\b/i,
  /\bignore\s+(that|the\s+previous)\b/i,
  /\bforget\s+(it|that|the\s+previous)\b/i,
];

function detectCorrectionReason(text: string): Correction["reason"] | null {
  const t = text.trim();
  if (INTERRUPT_PATTERNS.some((re) => re.test(t))) return "interrupt";
  if (EXPLICIT_PATTERNS.some((re) => re.test(t))) return "explicit";
  if (RETRY_PATTERNS.some((re) => re.test(t))) return "retry";
  return null;
}
