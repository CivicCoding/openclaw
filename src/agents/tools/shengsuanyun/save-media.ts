import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { ImageContent, TextContent } from "@mariozechner/pi-ai";

export async function saveMediaToWorkspace(
  url: string,
  workspaceDir: string,
  prefix: string = "media",
): Promise<TextContent | ImageContent> {
  const mediaDir = join(workspaceDir, "media_save");

  if (!existsSync(mediaDir)) {
    await mkdir(mediaDir, { recursive: true });
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download media: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const nodeBuffer = Buffer.from(buffer);
  const urlExt = extname(new URL(url).pathname);
  const mimeType = response.headers.get("content-type") || "";
  const ext = urlExt || getExtensionFromContentType(mimeType);
  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}${ext}`;
  const filepath = join(mediaDir, filename);
  await writeFile(filepath, nodeBuffer);
  if (mimeType.startsWith("image/")) {
    const base64String = nodeBuffer.toString("base64");
    return {
      type: "image",
      data: base64String,
      mimeType: mimeType,
    };
  }
  return { type: "text", text: filepath };
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
