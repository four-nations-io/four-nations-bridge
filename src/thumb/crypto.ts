// AES-256-GCM helpers — Phase F V0.3.
//
// doc 118 Part B: the key is the PER-TENANT content-encryption key (CEK) the gateway
// delivers in the pairing HELLO_ACK and the bridge persists in paired.json — the same
// key the tenant's browser fetches from GET /api/bridge/content-key (encrypt on the
// bridge, decrypt in the browser). This module takes the key as a hex arg (see
// encryptAesGcm's keyHex param); the caller passes config.encryptionKeyHex, which
// main.ts populates from paired.json. (Replaces the V0 single global stub key.)
//
// Frame on the wire carries `{ nonce, ciphertext }` where ciphertext
// includes the 16-byte GCM auth tag concatenated at the end (Node's standard
// `getAuthTag()` output, browser's `crypto.subtle.decrypt` expects this
// concat form).

import { createCipheriv, randomBytes } from 'node:crypto';

const NONCE_LEN = 12; // 96-bit GCM nonce, standard
const AUTH_TAG_LEN = 16;

export interface EncryptedBlob {
  /** 12-byte random nonce, fresh per encryption. */
  nonce: Buffer;
  /** Ciphertext bytes followed by the 16-byte GCM auth tag. */
  ciphertext: Buffer;
}

/**
 * Encrypt `plaintext` with AES-256-GCM using the V0 stub key (hex-decoded).
 * Returns nonce + ciphertext-with-appended-auth-tag. Throws if the key isn't
 * exactly 32 bytes after hex decode.
 */
export function encryptAesGcm(keyHex: string, plaintext: Buffer): EncryptedBlob {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      `encryption key must be 32 bytes after hex decode; got ${key.length}`
    );
  }
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_LEN) {
    // Should never happen with AES-GCM, but guard anyway.
    throw new Error(`AES-GCM authTag length ${authTag.length}, expected ${AUTH_TAG_LEN}`);
  }
  return { nonce, ciphertext: Buffer.concat([encrypted, authTag]) };
}
