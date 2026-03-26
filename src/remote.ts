import { getDestination } from "./config.ts";

/**
 * Run agent-history subcommand on a remote machine via SSH.
 * For local destinations, runs the command directly with HOME override.
 */
export async function runRemote(
  destName: string,
  subcommandArgs: string[],
): Promise<void> {
  const dest = await getDestination(destName);

  if (dest.type === "local") {
    // Run locally with HOME pointing to destination's home
    const cmd = new Deno.Command("agent-history", {
      args: subcommandArgs,
      env: { HOME: dest.home },
      stdout: "inherit",
      stderr: "inherit",
    });
    const { code } = await cmd.output();
    Deno.exit(code);
  }

  // SSH execution
  const sshTarget = dest.user ? `${dest.user}@${dest.host}` : dest.host!;
  const remoteCmd = ["agent-history", ...subcommandArgs].map(shellEscape).join(" ");

  const cmd = new Deno.Command("ssh", {
    args: ["-o", "BatchMode=yes", sshTarget, remoteCmd],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  Deno.exit(code);
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9._\-/=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
