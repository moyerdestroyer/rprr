import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mascot from "../assets/mascot-v3.png";
import type { PullRequest, RemoteReview } from "./github.ts";

async function notificationIcon(): Promise<{
  path: string;
  cleanup: () => Promise<void>;
} | null> {
  const embedded = Bun.embeddedFiles.find(
    (file) =>
      "name" in file &&
      typeof file.name === "string" &&
      file.name.startsWith("mascot-v3-") &&
      file.name.endsWith(".png"),
  );
  if (embedded) {
    const directory = await mkdtemp(join(tmpdir(), "rprr-notify-"));
    const path = join(directory, "mascot-v3.png");
    try {
      await writeFile(path, Buffer.from(await embedded.arrayBuffer()));
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return {
      path,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  }
  const path = mascot;
  return (await Bun.file(path).exists())
    ? { path, cleanup: async () => {} }
    : null;
}

export async function notifyDraft(
  pr: PullRequest,
  review: RemoteReview,
): Promise<void> {
  const executable = Bun.which("notify-send");
  if (!executable) return;
  let icon: Awaited<ReturnType<typeof notificationIcon>> = null;
  try {
    icon = await notificationIcon();
    const child = Bun.spawn(
      [
        executable,
        "--app-name=RPRR",
        ...(icon ? [`--icon=${icon.path}`] : []),
        "Draft review ready",
        `${pr.repository}#${pr.number}\n${review.url}`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Desktop notifications are optional; the draft is recorded in local state.
  } finally {
    await icon?.cleanup();
  }
}
