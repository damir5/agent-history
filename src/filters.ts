import type { AgentName, Filters } from "./types.ts";

/** Parse relative date strings like "7d", "1w", "1m" or ISO dates */
export function parseDate(input: string): Date {
  const relative = input.match(/^(\d+)([dwm])$/);
  if (relative) {
    const [, n, unit] = relative;
    const now = new Date();
    const ms = { d: 86400000, w: 604800000, m: 2592000000 }[unit!]!;
    return new Date(now.getTime() - parseInt(n!) * ms);
  }
  const d = new Date(input);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
  return d;
}

/** Check if a project path matches a glob pattern (simple glob: * only) */
export function matchProject(project: string, pattern: string): boolean {
  // Convert glob to regex: * → .*, escape rest
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    "i",
  );
  return re.test(project) || re.test(project.split("/").pop() ?? "");
}

/** Check if a timestamp (ISO string) is within filter range */
export function inDateRange(timestamp: string, filters: Filters): boolean {
  const t = new Date(timestamp).getTime();
  if (filters.from && t < filters.from.getTime()) return false;
  if (filters.to && t > filters.to.getTime()) return false;
  return true;
}

/** Convert unix ms to ISO string */
export function msToISO(ms: number): string {
  return new Date(ms).toISOString();
}

/** Convert unix seconds to ISO string */
export function secToISO(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/** Get home directory */
export function home(): string {
  return Deno.env.get("HOME") ?? "/tmp";
}

export function parseAgentFilter(input?: string): AgentName | "all" | undefined {
  if (!input) return undefined;
  const valid = ["claude", "gemini", "codex", "opencode", "all"];
  if (!valid.includes(input)) throw new Error(`Invalid agent: ${input}. Valid: ${valid.join(", ")}`);
  return input as AgentName | "all";
}

export function parseFilters(args: Record<string, unknown>): Filters {
  const filters: Filters = {};
  if (args.agent) filters.agent = parseAgentFilter(args.agent as string);
  if (args.project) filters.project = args.project as string;
  if (args.from) filters.from = parseDate(args.from as string);
  if (args.to) filters.to = parseDate(args.to as string);
  if (args.limit) filters.limit = parseInt(args.limit as string);
  if (args.query) filters.query = new RegExp(args.query as string, "i");
  return filters;
}
