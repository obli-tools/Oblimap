import crypto from 'crypto';
import { config, parseDataEncryptionKey } from '../config';
import { AppError } from '../middleware/errorHandler';

// Encryption at rest of stored secrets (SMTP passwords, Device Checks
// credentials…): AES-256-GCM with DATA_ENCRYPTION_KEY (base64 of 32 bytes).
//
// Every call takes an AAD ("additional authenticated data") string naming
// what the secret belongs to (e.g. `smtp:${id}`): a ciphertext copied onto
// another row does not decrypt. Without a valid key everything fails closed
// (encrypt* and decrypt of an encrypted value throw 409
// 'encryption_key_missing'); plaintext written before encryption existed
// is still readable through decryptString (legacy passthrough).

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const STRING_PREFIX = 'enc:v1:';

export interface SecretBoxJson {
  /** base64 */
  ciphertext: string;
  /** base64, 12 bytes */
  iv: string;
  /** base64, 16 bytes */
  authTag: string;
  /** DATA_ENCRYPTION_KEY_ID at write time */
  keyId: string;
}

/** Decryption failure: wrong key, wrong AAD or tampered data. Never carries secret material. */
export class SecretBoxError extends Error {
  constructor(message = 'Decryption failed') {
    super(message);
    this.name = 'SecretBoxError';
  }
}

// The key is read from config at each call (config is the single source of
// truth; tests set config.dataEncryptionKey), decoded once per value.
let cached: { raw: string; key: Buffer | null } | null = null;
function currentKey(): Buffer | null {
  const raw = config.dataEncryptionKey;
  if (!cached || cached.raw !== raw) cached = { raw, key: parseDataEncryptionKey(raw) };
  return cached.key;
}

function requireKey(): Buffer {
  const key = currentKey();
  if (!key) throw new AppError(409, 'encryption_key_missing');
  return key;
}

function aadBuffer(aad: string): Buffer {
  if (typeof aad !== 'string' || aad.length === 0) throw new TypeError('secretBox: aad must be a non-empty string');
  return Buffer.from(aad, 'utf8');
}

/** True when DATA_ENCRYPTION_KEY decodes to exactly 32 bytes. */
export function isAvailable(): boolean {
  return currentKey() !== null;
}

function seal(plain: Buffer, aad: string): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
  const key = requireKey();
  const additional = aadBuffer(aad);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additional);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function open(ciphertext: Buffer, iv: Buffer, authTag: Buffer, aad: string): Buffer {
  const key = requireKey();
  const additional = aadBuffer(aad);
  if (iv.length !== IV_BYTES || authTag.length !== TAG_BYTES) throw new SecretBoxError();
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(additional);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SecretBoxError();
  }
}

/** Encrypts JSON-serialisable data. Throws 409 'encryption_key_missing' without a valid key. */
export function encryptJson(value: unknown, aad: string): SecretBoxJson {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('secretBox: value is not JSON-serialisable');
  const box = seal(Buffer.from(json, 'utf8'), aad);
  return {
    ciphertext: box.ciphertext.toString('base64'),
    iv: box.iv.toString('base64'),
    authTag: box.authTag.toString('base64'),
    keyId: config.dataEncryptionKeyId,
  };
}

/** Decrypts encryptJson output. Throws SecretBoxError on wrong key / AAD or tampering. */
export function decryptJson<T>(box: SecretBoxJson, aad: string): T {
  if (!box || typeof box.ciphertext !== 'string' || typeof box.iv !== 'string' || typeof box.authTag !== 'string') {
    throw new SecretBoxError('Malformed encrypted value');
  }
  const plain = open(
    Buffer.from(box.ciphertext, 'base64'),
    Buffer.from(box.iv, 'base64'),
    Buffer.from(box.authTag, 'base64'),
    aad,
  );
  try {
    return JSON.parse(plain.toString('utf8')) as T;
  } catch {
    throw new SecretBoxError('Malformed encrypted value');
  }
}

/** True for values produced by encryptString. */
export function isEncrypted(s: unknown): s is string {
  return typeof s === 'string' && s.startsWith(STRING_PREFIX);
}

/**
 * Encrypts a string into a single column value:
 * 'enc:v1:<keyId>:<iv>:<tag>:<ciphertext>' (base64 parts).
 * Throws 409 'encryption_key_missing' without a valid key.
 */
export function encryptString(plain: string, aad: string): string {
  if (typeof plain !== 'string') throw new TypeError('secretBox: plain must be a string');
  const box = seal(Buffer.from(plain, 'utf8'), aad);
  return STRING_PREFIX + [
    config.dataEncryptionKeyId,
    box.iv.toString('base64'),
    box.authTag.toString('base64'),
    box.ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Reverses encryptString. A value without the 'enc:v1:' prefix is legacy
 * plaintext and is returned unchanged. Throws 409 'encryption_key_missing'
 * for an encrypted value without a valid key, SecretBoxError on wrong key /
 * AAD or tampering.
 */
export function decryptString(stored: string, aad: string): string {
  if (!isEncrypted(stored)) return stored;
  const parts = stored.slice(STRING_PREFIX.length).split(':');
  if (parts.length !== 4) throw new SecretBoxError('Malformed encrypted value');
  const [, iv, tag, ciphertext] = parts;
  return open(
    Buffer.from(ciphertext, 'base64'),
    Buffer.from(iv, 'base64'),
    Buffer.from(tag, 'base64'),
    aad,
  ).toString('utf8');
}
