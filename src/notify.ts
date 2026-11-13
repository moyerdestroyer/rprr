import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mascot from "../assets/mascot-v3.png";
import type { PullRequest, RemoteReview } from "./github.ts";

const emptyIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"></svg>';

function usesCinnamon(): boolean {
  return (
    process.env.XDG_CURRENT_DESKTOP?.split(":").includes("X-Cinnamon") ?? false
  );
}

async function notificationAssets(): Promise<{
  iconPath: string;
  imagePath?: string;
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
      if (usesCinnamon()) {
        const iconPath = join(directory, "empty-icon.svg");
        await writeFile(iconPath, emptyIcon);
        return {
          iconPath,
          imagePath: path,
          cleanup: () => rm(directory, { recursive: true, force: true }),
        };
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return {
      iconPath: path,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  }
  const path = mascot;
  if (!(await Bun.file(path).exists())) return null;
  if (!usesCinnamon()) return { iconPath: path, cleanup: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), "rprr-notify-"));
  const iconPath = join(directory, "empty-icon.svg");
  try {
    await writeFile(iconPath, emptyIcon);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    iconPath,
    imagePath: path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function notifyDraft(
  pr: PullRequest,
  review: RemoteReview,
): Promise<void> {
  const executable = Bun.which("notify-send");
  if (!executable) return;
  let assets: Awaited<ReturnType<typeof notificationAssets>> = null;
  try {
    assets = await notificationAssets();
    const child = Bun.spawn(
      [
        executable,
        "--app-name=RPRR",
        ...(assets ? [`--icon=${assets.iconPath}`] : []),
        ...(assets?.imagePath
          ? [`--hint=string:image-path:${assets.imagePath}`]
          : []),
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
    await assets?.cleanup();
  }
}
