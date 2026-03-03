import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";

export async function saveMediaToWorkspace(
  url: string,
  workspaceDir: string,
  prefix: string = "media",
): Promise<string> {
  const mediaDir = join(workspaceDir, "media_save");

  if (!existsSync(mediaDir)) {
    await mkdir(mediaDir, { recursive: true });
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download media: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const urlExt = extname(new URL(url).pathname);
  const ext = urlExt || getExtensionFromContentType(response.headers.get("content-type") || "");
  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}${ext}`;
  const filepath = join(mediaDir, filename);

  await writeFile(filepath, Buffer.from(buffer));
  return filepath;
}

function getExtensionFromContentType(contentType: string): string {
  const typeMap: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
  };
  return typeMap[contentType] || contentType.split("/")[1] || "";
}
