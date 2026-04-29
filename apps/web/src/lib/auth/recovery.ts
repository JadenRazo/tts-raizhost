// Recovery codes — used as a fallback when the user loses access to their
// authenticator. Codes are shown ONCE at enrollment (or during recovery
// regeneration) and stored as bcrypt hashes in users.recovery_codes_enc as a
// JSON array. On use, we walk the array and mark a matching index null so it
// cannot be reused.

import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const CODE_COUNT = 8;
const BCRYPT_ROUNDS = 10;

export function generateRecoveryCodes(): {
  plain: string[];
  hashes: string[];
} {
  const plain: string[] = [];
  for (let i = 0; i < CODE_COUNT; i++) {
    const hex = crypto.randomBytes(6).toString("hex");
    plain.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`);
  }
  const hashes = plain.map((c) => bcrypt.hashSync(c, BCRYPT_ROUNDS));
  return { plain, hashes };
}

export function serializeHashes(hashes: (string | null)[]): string {
  return JSON.stringify(hashes);
}

export function parseHashes(blob: string): (string | null)[] {
  try {
    const arr = JSON.parse(blob);
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => (typeof x === "string" ? x : null));
  } catch {
    return [];
  }
}

/**
 * Returns the index of the matching hash, or -1 if none match.
 * Callers should set the matched index to null in the array and persist
 * the updated JSON so the code cannot be reused.
 */
export function findMatchingCodeIndex(
  code: string,
  hashes: (string | null)[],
): number {
  const trimmed = code.trim().toLowerCase();
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i];
    if (!h) continue;
    if (bcrypt.compareSync(trimmed, h)) return i;
  }
  return -1;
}
