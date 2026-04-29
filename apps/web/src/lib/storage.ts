// On-disk PDF storage. Books live at <BOOKS_DIR>/<userId>/<bookId>.pdf.
//
// Path traversal defense: every userId/bookId is validated as a UUID before
// it's joined into a path. Anything that isn't 8-4-4-4-12 hex throws before
// we touch the filesystem.

import { createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { env } from "@/lib/env";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

export function bookPath(userId: string, bookId: string): string {
  assertUuid(userId, "userId");
  assertUuid(bookId, "bookId");
  return path.join(env.BOOKS_DIR, userId, `${bookId}.pdf`);
}

export async function writeBook(
  userId: string,
  bookId: string,
  data: Buffer | Uint8Array,
): Promise<void> {
  const finalPath = bookPath(userId, bookId);
  const dir = path.dirname(finalPath);
  await mkdir(dir, { recursive: true });

  // Write to a sibling tmp file then rename — atomic on the same filesystem,
  // so partial writes never appear under the canonical name. If either step
  // fails (disk full, EXDEV, perms), we unlink the tmp before re-throwing so
  // the user dir doesn't accumulate orphans on a degraded volume.
  const tmpPath = `${finalPath}.tmp`;
  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, finalPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export async function deleteBook(
  userId: string,
  bookId: string,
): Promise<void> {
  const target = bookPath(userId, bookId);
  try {
    await unlink(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }
}

export async function bookFileSize(
  userId: string,
  bookId: string,
): Promise<number | null> {
  try {
    const s = await stat(bookPath(userId, bookId));
    return s.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function streamBook(userId: string, bookId: string): ReadableStream {
  const node = createReadStream(bookPath(userId, bookId));
  // Node's Readable.toWeb adapter — converts to a standards ReadableStream
  // suitable for returning from a Next route handler.
  return Readable.toWeb(node) as ReadableStream;
}
