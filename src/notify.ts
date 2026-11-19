import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import mascot from "../assets/mascot-v3.png";
import { appPaths } from "./config.ts";
import type { PullRequest, RemoteReview } from "./github.ts";

async function notificationIcon(): Promise<string> {
  const embedded = Bun.embeddedFiles.find(
    (file) =>
      "name" in file &&
      typeof file.name === "string" &&
      file.name.startsWith("mascot-v3-") &&
      file.name.endsWith(".png"),
  );
  const data = Buffer.from(await (embedded ?? Bun.file(mascot)).arrayBuffer());
  const digest = createHash("sha256").update(data).digest("hex").slice(0, 16);
  const directory = join(appPaths().cache, "notifications");
  const path = join(directory, `mascot-v3-${digest}.png`);
  if (await Bun.file(path).exists()) return path;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  // The daemon may load images after notify-send exits, or when reopening history.
  return path;
}

export async function notifyDraft(
  pr: PullRequest,
  review: RemoteReview,
): Promise<void> {
  const executable = Bun.which("notify-send");
  if (!executable) return;
  try {
    const icon = await notificationIcon().catch(() => undefined);
    const cinnamon = process.env.XDG_CURRENT_DESKTOP?.split(":").some(
      (desktop) => desktop.toLowerCase().includes("cinnamon"),
    );
    const child = Bun.spawn(
      [
        executable,
        "--app-name=RPRR",
        // Cinnamon and GNOME use urgency to control banner duration separately
        // from notification expiry. The draft requires the reviewer's attention.
        "--urgency=critical",
        "--expire-time=0",
        "--hint=boolean:resident:true",
        ...(icon ? [`--icon=${icon}`] : []),
        ...(icon && cinnamon ? [`--hint=string:image-path:${icon}`] : []),
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
  }
}
