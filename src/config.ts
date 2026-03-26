import { parse as parseYaml } from "@std/yaml";
import { home } from "./filters.ts";

export interface Destination {
  name: string;
  type: "ssh" | "local";
  host?: string;
  user?: string;
  home: string;
  os?: string;
}

interface SyncConfig {
  destinations?: Record<string, {
    type: string;
    host?: string;
    user?: string;
    home: string;
    os?: string;
  }>;
}

export async function loadDestinations(): Promise<Destination[]> {
  const path = `${home()}/.ade/config/sync.yaml`;
  try {
    const text = await Deno.readTextFile(path);
    const config = parseYaml(text) as SyncConfig;
    if (!config.destinations) return [];
    return Object.entries(config.destinations).map(([name, d]) => ({
      name,
      type: d.type as "ssh" | "local",
      host: d.host,
      user: d.user,
      home: d.home,
      os: d.os,
    }));
  } catch {
    return [];
  }
}

export async function getDestination(name: string): Promise<Destination> {
  const dests = await loadDestinations();
  const dest = dests.find((d) => d.name === name);
  if (!dest) {
    const names = dests.map((d) => d.name).join(", ");
    throw new Error(`Unknown destination: ${name}. Available: ${names}`);
  }
  return dest;
}
