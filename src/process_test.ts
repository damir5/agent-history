import { assertEquals, assertInstanceOf } from "@std/assert";
import { CommandTimeoutError, runCommand } from "./process.ts";

Deno.test("runCommand writes stdin and captures output", async () => {
  const result = await runCommand("/bin/cat", {
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    stdinText: "hello\n",
    timeoutMs: 1_000,
  });

  assertEquals(result.success, true);
  assertEquals(new TextDecoder().decode(result.stdout), "hello\n");
});

Deno.test("runCommand kills commands that ignore the timeout", async () => {
  try {
    await runCommand(Deno.execPath(), {
      args: [
        "eval",
        "Deno.addSignalListener('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      stdout: "piped",
      stderr: "piped",
      timeoutMs: 100,
      killGraceMs: 100,
      label: "stubborn-test-command",
    });
  } catch (err) {
    assertInstanceOf(err, CommandTimeoutError);
    await waitUntilGone(err.pid);
    return;
  }

  throw new Error("expected timeout");
});

async function waitUntilGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!(await processExists(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process ${pid} is still running`);
}

async function processExists(pid: number): Promise<boolean> {
  const result = await new Deno.Command("/bin/kill", {
    args: ["-0", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
  return result.success;
}
