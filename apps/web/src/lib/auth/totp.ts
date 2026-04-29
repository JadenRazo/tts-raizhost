// TOTP secret encryption + verification.
//
// At-rest: secrets are AES-256-GCM encrypted with AUTH_KMS_KEY (32 bytes,
// hex-encoded in env). Format on disk: "<iv_b64>.<tag_b64>.<ct_b64>".
// Verification: otpauth.TOTP.validate with window: 1 (one 30s step skew).

import crypto from "node:crypto";
import { Secret, TOTP } from "otpauth";
import { env } from "@/lib/env";

const ALG = "aes-256-gcm";
const IV_LEN = 12;

function key(): Buffer {
  return Buffer.from(env.AUTH_KMS_KEY, "hex");
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key(), iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(".");
}

export function decryptSecret(blob: string): string {
  const [iv, tag, ct] = blob
    .split(".")
    .map((s) => Buffer.from(s, "base64"));
  if (!iv || !tag || !ct) {
    throw new Error("Malformed encrypted secret");
  }
  const decipher = crypto.createDecipheriv(ALG, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}

export function generateTotpSecret(): {
  base32: string;
  otpauthUrl: (label: string) => string;
} {
  const secret = new Secret({ size: 20 });
  return {
    base32: secret.base32,
    otpauthUrl: (label) =>
      new TOTP({
        issuer: "tts.raizhost.com",
        label,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret,
      }).toString(),
  };
}

export function verifyTotpToken(token: string, secretBase32: string): boolean {
  const trimmed = token.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(trimmed)) return false;
  const totp = new TOTP({
    secret: Secret.fromBase32(secretBase32),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });
  return totp.validate({ token: trimmed, window: 1 }) !== null;
}
