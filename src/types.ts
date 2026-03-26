/** Unified message across all agents */
export interface Message {
  agent: AgentName;
  role: "user" | "assistant";
  text: string;
  timestamp: string; // ISO 8601
  sessionId: string;
  project: string;
  model?: string;
}

/** Unified session across all agents */
export interface Session {
  agent: AgentName;
  sessionId: string;
  project: string;
  startTime: string; // ISO 8601
  lastTime?: string;
  messageCount: number;
  model?: string;
}

/** Aggregate stats */
export interface Stats {
  agent: AgentName;
  sessions: number;
  messages: number;
  projects: string[];
  tokenUsage?: number;
  models: string[];
}

/** Correction = a user message that corrects the agent */
export interface Correction {
  agent: AgentName;
  sessionId: string;
  project: string;
  timestamp: string;
  correction: string; // the corrective message
  context: string[]; // preceding messages for context
  reason: CorrectionReason;
}

export type CorrectionReason = "explicit" | "interrupt" | "retry";

export type AgentName = "claude" | "gemini" | "codex" | "opencode";

export interface Filters {
  agent?: AgentName | "all";
  project?: string; // glob pattern
  from?: Date;
  to?: Date;
  limit?: number;
  query?: RegExp;
}

export interface HistoryAdapter {
  name: AgentName;
  available(): Promise<boolean>;
  search(filters: Filters): AsyncIterable<Message>;
  sessions(filters: Filters): AsyncIterable<Session>;
  conversation(sessionId: string): AsyncIterable<Message>;
  stats(filters: Filters): Promise<Stats>;
  corrections(filters: Filters): AsyncIterable<Correction>;
}
