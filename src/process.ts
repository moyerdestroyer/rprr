import { type ChildProcess, spawn } from "node:child_process";

export class ProcessTimeoutError extends Error {}
export class ProcessOutputLimitError extends Error {}

function stopProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
}

// Callers spawn a detached process so its descendants share a private group.
export async function withProcessTimeout<T>(
  child: ChildProcess,
  timeoutMs: number,
  label: string,
  body: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onError: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    onError = reject;
    child.once("error", onError);
    timer = setTimeout(() => {
      reject(
        new ProcessTimeoutError(
          `${label} timed out after ${timeoutMs / 1000}s`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([body(), deadline]);
  } finally {
    clearTimeout(timer);
    stopProcessTree(child);
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.removeListener("error", onError);
  }
}

function takeOutput(
  output: { text: string; bytes: number },
  chunk: string,
  maxOutputBytes: number,
  label: string,
): void {
  const bytes = Buffer.byteLength(chunk);
  if (output.bytes + bytes > maxOutputBytes)
    throw new ProcessOutputLimitError(
      `${label} output exceeded ${maxOutputBytes} bytes`,
    );
  output.bytes += bytes;
  output.text += chunk;
}

export async function runCommand(
  command: string[],
  cwd?: string,
  timeoutMs = 120_000,
  maxOutputBytes = Number.POSITIVE_INFINITY,
): Promise<string> {
  const executable = command[0];
  if (!executable) throw new Error("Command is empty");
  const label = command.slice(0, 3).join(" ");
  const child = spawn(executable, command.slice(1), {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return withProcessTimeout(
    child,
    timeoutMs,
    label,
    () =>
      new Promise<string>((resolve, reject) => {
        const output = { text: "", bytes: 0 };
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          try {
            takeOutput(output, chunk, maxOutputBytes, label);
          } catch (error) {
            reject(error);
            child.stdout.destroy();
          }
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-4000);
        });
        child.once("close", (code, signal) => {
          if (code === 0) resolve(output.text);
          else
            reject(
              new Error(
                `${executable} failed (${signal ?? `exit ${code}`}): ${stderr.trim() || output.text.trim().slice(-4000)}`,
              ),
            );
        });
      }),
  );
}
