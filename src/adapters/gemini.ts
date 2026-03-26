import { join } from "jsr:@std/path";
import type {
  Correction,
  CorrectionReason,
  Filters,
  HistoryAdapter,
  Message,
  Session,
  Stats,
} from "../types.ts";
import { home, inDateRange, matchProject } from "../filters.ts";

// Raw shapes from Gemini session JSON files

interface GeminiContent {
  text: string;
}

interface GeminiThought {
  subject: string;
  description: string;
}

interface GeminiToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown[];
  status: string;
}

interface GeminiTokens {
  input: number;
  output: number;
  total: number;
}

interface GeminiMessage {
  id: string;
  timestamp: string;
  type: "user" | "gemini";
  content: GeminiContent[];
  thoughts?: GeminiThought[];
  tokens?: GeminiTokens;
  model?: string;
  toolCalls?: GeminiToolCall[];
}

interface GeminiSession {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: GeminiMessage[];
}

// Correction trigger words (same heuristic as other adapters)
const CORRECTION_WORDS = [
  "no,",
  "no.",
  "wrong",
  "incorrect",
  "that's not",
  "that is not",
  "actually",
  "wait,",
  "wait.",
  "stop,",
  "stop.",
  "undo",
  "revert",
  "go back",
  "not what i",
  "not what I",
  "you misunderstood",
  "you're wrong",
  "you are wrong",
];

function geminiDir(): string {
  return join(home(), ".gemini", "tmp");
}

function extractText(content: GeminiContent[]): string {
  return content.map((c) => c.text).join("").trim();
}

function pickModel(messages: GeminiMessage[]): string | undefined {
  for (const m of messages) {
    if (m.type === "gemini" && m.model) return m.model;
  }
  return undefined;
}

function collectModels(messages: GeminiMessage[]): string[] {
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.type === "gemini" && m.model) seen.add(m.model);
  }
  return [...seen];
}

function totalTokens(messages: GeminiMessage[]): number {
  let sum = 0;
  for (const m of messages) {
    if (m.tokens) sum += m.tokens.total;
  }
  return sum;
}

async function* listSessionFiles(): AsyncIterable<{ file: string; project: string }> {
  const base = geminiDir();
  try {
    for await (const projectEntry of Deno.readDir(base)) {
      if (!projectEntry.isDirectory) continue;
      const chatsDir = join(base, projectEntry.name, "chats");
      try {
        for await (const chatEntry of Deno.readDir(chatsDir)) {
          if (!chatEntry.isFile || !chatEntry.name.endsWith(".json")) continue;
          yield {
            file: join(chatsDir, chatEntry.name),
            project: projectEntry.name,
          };
        }
      } catch {
        // chats dir may not exist
      }
    }
  } catch {
    // base dir may not exist
  }
}

async function parseFile(file: string): Promise<GeminiSession | null> {
  try {
    const raw = await Deno.readTextFile(file);
    return JSON.parse(raw) as GeminiSession;
  } catch {
    return null;
  }
}

function sessionMatchesFilters(
  session: GeminiSession,
  project: string,
  filters: Filters,
): boolean {
  if (filters.project && !matchProject(project, filters.project)) return false;
  // Date range: check if session overlaps with filter range using startTime/lastUpdated
  if (filters.from || filters.to) {
    const start = session.startTime;
    const end = session.lastUpdated;
    // Exclude session if it ended before `from` or started after `to`
    if (filters.from && new Date(end).getTime() < filters.from.getTime()) return false;
    if (filters.to && new Date(start).getTime() > filters.to.getTime()) return false;
  }
  return true;
}

function toMessage(msg: GeminiMessage, sessionId: string, project: string): Message {
  return {
    agent: "gemini",
    role: msg.type === "user" ? "user" : "assistant",
    text: extractText(msg.content),
    timestamp: msg.timestamp,
    sessionId,
    project,
    model: msg.type === "gemini" ? msg.model : undefined,
  };
}

function detectCorrectionReason(
  msg: GeminiMessage,
  prevMsg: GeminiMessage | undefined,
): CorrectionReason | null {
  const text = extractText(msg.content).toLowerCase();

  // Explicit: starts with or contains correction words
  for (const word of CORRECTION_WORDS) {
    if (text.startsWith(word.toLowerCase()) || text.includes(word.toLowerCase())) {
      return "explicit";
    }
  }

  // Interrupt: user message follows another user message (no assistant response between)
  if (prevMsg && prevMsg.type === "user") {
    return "interrupt";
  }

  return null;
}

export const geminiAdapter: HistoryAdapter = {
  name: "gemini",

  async available(): Promise<boolean> {
    try {
      const stat = await Deno.stat(geminiDir());
      return stat.isDirectory;
    } catch {
      return false;
    }
  },

  async *search(filters: Filters): AsyncIterable<Message> {
    let count = 0;
    for await (const { file, project } of listSessionFiles()) {
      const session = await parseFile(file);
      if (!session) continue;
      if (!sessionMatchesFilters(session, project, filters)) continue;

      for (const msg of session.messages) {
        if (msg.type !== "user") continue;
        if (!inDateRange(msg.timestamp, filters)) continue;

        const text = extractText(msg.content);
        if (filters.query && !filters.query.test(text)) continue;

        yield toMessage(msg, session.sessionId, project);
        count++;
        if (filters.limit && count >= filters.limit) return;
      }
    }
  },

  async *sessions(filters: Filters): AsyncIterable<Session> {
    let count = 0;
    for await (const { file, project } of listSessionFiles()) {
      const session = await parseFile(file);
      if (!session) continue;
      if (!sessionMatchesFilters(session, project, filters)) continue;

      yield {
        agent: "gemini",
        sessionId: session.sessionId,
        project,
        startTime: session.startTime,
        lastTime: session.lastUpdated,
        messageCount: session.messages.length,
        model: pickModel(session.messages),
      };

      count++;
      if (filters.limit && count >= filters.limit) return;
    }
  },

  async *conversation(sessionId: string): AsyncIterable<Message> {
    for await (const { file, project } of listSessionFiles()) {
      const session = await parseFile(file);
      if (!session || session.sessionId !== sessionId) continue;

      for (const msg of session.messages) {
        yield toMessage(msg, session.sessionId, project);
      }
      return;
    }
  },

  async stats(filters: Filters): Promise<Stats> {
    const projects = new Set<string>();
    const models = new Set<string>();
    let sessionCount = 0;
    let messageCount = 0;
    let tokenUsage = 0;

    for await (const { file, project } of listSessionFiles()) {
      const session = await parseFile(file);
      if (!session) continue;
      if (!sessionMatchesFilters(session, project, filters)) continue;

      sessionCount++;
      messageCount += session.messages.length;
      projects.add(project);
      tokenUsage += totalTokens(session.messages);
      for (const m of collectModels(session.messages)) models.add(m);
    }

    return {
      agent: "gemini",
      sessions: sessionCount,
      messages: messageCount,
      projects: [...projects],
      tokenUsage: tokenUsage > 0 ? tokenUsage : undefined,
      models: [...models],
    };
  },

  async *corrections(filters: Filters): AsyncIterable<Correction> {
    let count = 0;
    for await (const { file, project } of listSessionFiles()) {
      const session = await parseFile(file);
      if (!session) continue;
      if (!sessionMatchesFilters(session, project, filters)) continue;

      const msgs = session.messages;
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        if (msg.type !== "user") continue;
        if (!inDateRange(msg.timestamp, filters)) continue;
        if (filters.project && !matchProject(project, filters.project)) continue;

        const prevMsg = i > 0 ? msgs[i - 1] : undefined;
        const reason = detectCorrectionReason(msg, prevMsg);
        if (!reason) continue;

        // Collect up to 3 preceding messages as context
        const context: string[] = [];
        for (let j = Math.max(0, i - 3); j < i; j++) {
          context.push(extractText(msgs[j].content));
        }

        yield {
          agent: "gemini",
          sessionId: session.sessionId,
          project,
          timestamp: msg.timestamp,
          correction: extractText(msg.content),
          context,
          reason,
        };

        count++;
        if (filters.limit && count >= filters.limit) return;
      }
    }
  },
};
