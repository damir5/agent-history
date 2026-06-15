export interface CommandResult {
  code: number;
  success: boolean;
  signal: Deno.Signal | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

interface RunCommandOptions extends Deno.CommandOptions {
  stdinText?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  label?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const EMPTY_BYTES = new Uint8Array();

export class CommandTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly pid: number,
    readonly timeoutMs: number,
  ) {
    super(
      `${label} timed out after ${timeoutMs}ms; process ${pid} was terminated`,
    );
    this.name = "CommandTimeoutError";
  }
}

export async function runCommand(
  command: string,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const {
    stdinText,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    label = command,
    ...commandOptions
  } = options;

  const cmd = new Deno.Command(command, commandOptions);
  const proc = cmd.spawn();
  const outputPromise = readOutput(proc, commandOptions);
  const stdinPromise = writeStdin(proc, stdinText);
  const runPromise = Promise.all([stdinPromise, outputPromise]).then((
    [, result],
  ) => result);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(async () => {
      await terminate(proc, killGraceMs);
      reject(new CommandTimeoutError(label, proc.pid, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    runPromise.catch(() => undefined);
  }
}

async function readOutput(
  proc: Deno.ChildProcess,
  options: Deno.CommandOptions,
): Promise<CommandResult> {
  if (options.stdout === "inherit" || options.stderr === "inherit") {
    const status = await proc.status;
    return {
      ...status,
      stdout: EMPTY_BYTES,
      stderr: EMPTY_BYTES,
    };
  }

  return await proc.output();
}

async function writeStdin(
  proc: Deno.ChildProcess,
  stdinText?: string,
): Promise<void> {
  if (stdinText === undefined) return;

  const writer = proc.stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(stdinText));
  } finally {
    await writer.close().catch(() => undefined);
  }
}

async function terminate(
  proc: Deno.ChildProcess,
  killGraceMs: number,
): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }

  const exited = await Promise.race([
    proc.status.then(() => true),
    delay(killGraceMs).then(() => false),
  ]);
  if (exited) return;

  try {
    proc.kill("SIGKILL");
  } catch {
    return;
  }

  await Promise.race([
    proc.status.catch(() => undefined),
    delay(killGraceMs),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
