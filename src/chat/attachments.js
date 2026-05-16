import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function createAttachmentResolver({ workingDirectory }) {
  return {
    resolveImageBlock: (block, index) =>
      resolveImageBlock(block, index, { workingDirectory }),
  };
}

export async function resolveImageBlock(block, index, { workingDirectory } = {}) {
  if (!block || typeof block !== "object") return null;
  const type = block.type;

  if (type === "local_image") {
    const candidate =
      typeof block.path === "string"
        ? block.path
        : typeof block.image_path === "string"
          ? block.image_path
          : null;
    if (!candidate) {
      throw new Error(`Message ${index + 1} local_image block is missing path.`);
    }
    return { path: resolveImagePath(candidate, { workingDirectory }) };
  }

  if (type === "image_url" || type === "input_image") {
    const candidate =
      typeof block.image_url?.url === "string"
        ? block.image_url.url
        : typeof block.url === "string"
          ? block.url
          : null;
    if (!candidate) {
      throw new Error(`Message ${index + 1} image_url block is missing url.`);
    }
    return resolveImageUrlReference(candidate, { workingDirectory });
  }

  return null;
}

export function resolveImagePath(value, { workingDirectory } = {}) {
  if (typeof value !== "string") {
    throw new Error("Image reference must be a string path or URL.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Image reference cannot be empty.");
  }
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    const scheme = trimmed.split(":")[0].toLowerCase();
    if (scheme !== "file") {
      throw new Error(
        "Only file:// URLs, HTTP(S) URLs, or local file paths are supported for images.",
      );
    }
    try {
      return fileURLToPath(trimmed);
    } catch {
      throw new Error("Invalid file:// URL provided for image attachment.");
    }
  }
  if (/^[a-z]+:/i.test(trimmed)) {
    throw new Error(
      "Only file:// URLs, HTTP(S) URLs, or local file paths are supported for images.",
    );
  }
  const baseDir = workingDirectory ?? process.cwd();
  return path.resolve(baseDir, trimmed);
}

export async function resolveImageUrlReference(value, { workingDirectory } = {}) {
  if (typeof value !== "string") {
    throw new Error("Image reference must be a string path or URL.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Image reference cannot be empty.");
  }
  if (trimmed.startsWith("data:")) {
    return createTempFileFromDataUrl(trimmed);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return downloadImageToTempFile(trimmed);
  }
  return { path: resolveImagePath(trimmed, { workingDirectory }) };
}

export async function createTempFileFromDataUrl(dataUrl) {
  const match = /^data:(?<mime>[^;]+);base64,(?<payload>.+)$/i.exec(dataUrl);
  if (!match?.groups?.payload) {
    throw new Error("Invalid data URL provided for image attachment.");
  }
  const mime = match.groups.mime;
  const base64 = match.groups.payload.replace(/\s+/g, "");
  const buffer = Buffer.from(base64, "base64");
  return writeTempImageFile(buffer, inferExtensionFromMime(mime));
}

export async function downloadImageToTempFile(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download image from ${url} (status ${response.status}).`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get("content-type");
  return writeTempImageFile(buffer, inferExtensionFromMime(contentType));
}

export async function writeTempImageFile(buffer, extension = ".png") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-image-"));
  const safeExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const filePath = path.join(dir, `attachment${safeExtension}`);
  await fs.writeFile(filePath, buffer);
  const cleanup = async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn("Failed to remove temporary image directory:", error);
    }
  };
  return { path: filePath, cleanup };
}

export function inferExtensionFromMime(mime) {
  if (!mime) return ".png";
  const normalized = mime.toLowerCase();
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("bmp")) return ".bmp";
  return ".png";
}

export function collectAttachmentCleanups(messages) {
  const cleanups = [];
  if (!Array.isArray(messages)) return cleanups;
  for (const entry of messages) {
    if (!Array.isArray(entry?.attachments)) continue;
    for (const attachment of entry.attachments) {
      if (typeof attachment?.cleanup === "function") {
        cleanups.push(attachment.cleanup);
      }
    }
  }
  return cleanups;
}

export async function cleanupAttachmentFiles(cleanups) {
  if (!Array.isArray(cleanups) || cleanups.length === 0) return;
  await Promise.all(
    cleanups.map(async (cleanup) => {
      try {
        await cleanup();
      } catch (error) {
        console.warn("Failed to cleanup temporary attachment:", error);
      }
    }),
  );
}
