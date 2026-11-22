// Application-level encryption (design 0001 §4.6; design 0002 §8). Runs only in the API and worker processes:
// the database never sees an unwrapped key.
//   envelope = version (1 byte, 0x01) | key_id (16 bytes) | nonce (24 bytes, CSPRNG) | ciphertext+tag
//   AAD (data)        = <instance slug>|<schema>.<table>.<column>|<row id>
//   AAD (wrapped DEK) = <instance slug>|dek|<purpose>|<key_id>
//   blind index       = version (1 byte) | HMAC-SHA256(index_key, normalize_v(value))
import { createHmac } from 'node:crypto';
import sodiumModule from 'libsodium-wrappers';
import * as normalize from './normalize.js';

const VERSION = 0x01;
const NONCE = 24;
const HEADER = 1 + 16 + NONCE;
let sodium;
/** Must be awaited once before any other call. */
export async function ready() { await sodiumModule.ready; sodium = sodiumModule; }
const need = () => { if (!sodium) throw new Error('crypto: call ready() first'); return sodium; };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidBytes = (id) => { if (!UUID.test(id)) throw new Error('crypto: key_id must be a uuid'); return Buffer.from(id.replace(/-/g, ''), 'hex'); };
const bytesUuid = (b) => { const h = Buffer.from(b).toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const key32 = (k) => { if (!(k instanceof Uint8Array) || k.length !== 32) throw new Error('crypto: keys are 32 bytes'); return k; };

export const dataAad = (slug, column, rowId) => {
  if (!/^[a-z_]+\.[a-z_]+\.[a-z_]+$/.test(column)) throw new Error('crypto: column is schema.table.column');
  if (!UUID.test(rowId)) throw new Error('crypto: row id must be a uuid');
  return `${slug}|${column}|${rowId}`;
};
export const dekAad = (slug, purpose, keyId) => `${slug}|dek|${purpose}|${keyId}`;

/** Encrypt with the key registered as keyId (a DEK, or the KEK when wrapping). */
export function seal(key, keyId, plaintext, aad) {
  const s = need();
  const nonce = s.randombytes_buf(NONCE);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key32(key));
  return Buffer.concat([Buffer.from([VERSION]), uuidBytes(keyId), Buffer.from(nonce), Buffer.from(ct)]);
}

/** Returns the key id an envelope names, so the caller can load that key; throws on an unknown version. */
export function keyIdOf(envelope) {
  const b = Buffer.from(envelope);
  if (b.length <= HEADER || b[0] !== VERSION) throw new Error('crypto: unknown envelope');
  return bytesUuid(b.subarray(1, 17));
}

/** Decrypt; any change to bytes, key or AAD throws. */
export function open(key, envelope, aad) {
  const s = need();
  const b = Buffer.from(envelope);
  keyIdOf(b);
  try {
    return Buffer.from(s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, b.subarray(HEADER), aad, b.subarray(17, HEADER), key32(key)));
  } catch { throw new Error('crypto: cannot decrypt'); }
}

export const wrapDek = (kek, kekId, dek, slug, purpose, keyId) => seal(kek, kekId, key32(dek), dekAad(slug, purpose, keyId));
export const unwrapDek = (kek, wrapped, slug, purpose, keyId) => open(kek, wrapped, dekAad(slug, purpose, keyId));

/** Blind index of an e-mail (normalization v1); the key version byte travels with the value. */
export function emailIndex(indexKey, version, email) {
  if (!Number.isInteger(version) || version < 1 || version > 255) throw new Error('crypto: index version is one byte');
  const mac = createHmac('sha256', key32(indexKey)).update(normalize.email(email), 'utf8').digest();
  return Buffer.concat([Buffer.from([version]), mac]);
}

/** KEKs come from the process environment (instance secret store): MANDATO_KEK_<kek_id with _ for ->, base64, 32 bytes. */
export function loadKek(kekId, env = process.env) {
  const v = env[`MANDATO_KEK_${kekId.replace(/-/g, '_')}`];
  if (!v) throw new Error(`crypto: KEK ${kekId} not loaded`);
  return key32(new Uint8Array(Buffer.from(v, 'base64')));
}
