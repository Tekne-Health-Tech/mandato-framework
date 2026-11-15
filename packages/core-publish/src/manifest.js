// Signed manifest (design 0001 §6.3): RFC 8785 canonical JSON, Ed25519 signature, reference client algorithm.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/** RFC 8785 JSON Canonicalization Scheme for the value types the manifest uses. */
export function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();   // UTF-16 code unit order
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export const privateKeyFromSeed = (seed) => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
export const publicKeyString = (privateKey) => `ed25519:${b64u(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12))}`;
const publicKeyFromString = (s) => createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(s.replace(/^ed25519:/, ''), 'base64url')]), format: 'der', type: 'spki' });

export function signManifest(unsigned, keyId, privateKey) {
  const { sig: _drop, ...body } = unsigned;
  const value = b64u(sign(null, Buffer.from(canonicalize(body), 'utf8'), privateKey));
  return { ...body, sig: { key_id: keyId, alg: 'Ed25519', value } };
}

/**
 * Reference client algorithm, steps 2–5 of §6.3.
 * keyring: [{ key_id, public_key, role: 'current' | 'next', revoked? }]; state: { generation, minGenerationAtBuild, appVersion }.
 * Returns { accept, reason, takedowns, dropAll, stopAfterTakedowns, keyring }. `keyring` is the keyring the device must
 * store from now on: a `keyring_update` signed by a current key revokes keys and adds a `next` key. Revocation is final.
 */
export function evaluateManifest(manifest, keyring, state, now = new Date()) {
  const reject = (reason) => ({ accept: false, reason });
  const { sig, ...body } = manifest;
  if (!sig || sig.alg !== 'Ed25519') return reject('unsigned');
  const key = keyring.find((k) => k.key_id === sig.key_id && !k.revoked);
  if (!key) return reject('unknown-key');
  const okSig = verify(null, Buffer.from(canonicalize(body), 'utf8'), publicKeyFromString(key.public_key), Buffer.from(sig.value, 'base64url'));
  if (!okSig) return reject('bad-signature');
  if (new Date(manifest.expires_at) <= now) return reject('expired');
  if (manifest.generation < Math.max(state.generation ?? 0, state.minGenerationAtBuild ?? 0)) return reject('rollback');
  let nextKeyring = keyring;
  if (manifest.keyring_update) {
    if (key.role !== 'current') return reject('keyring-update-not-signed-by-current');
    nextKeyring = applyKeyringUpdate(keyring, manifest.keyring_update);
  }
  const tooOld = compareVersions(manifest.min_app_version, state.appVersion) > 0;
  return {
    accept: true,
    keyring: nextKeyring,
    takedowns: manifest.takedowns,                                   // always applied first
    stopAfterTakedowns: tooOld,                                      // unsupported app: purge, then stop
    dropAll: (state.generation ?? 0) < manifest.min_generation,
  };
}

export function applyKeyringUpdate(keyring, update) {
  const revoke = new Set(update.revoke ?? []);
  const out = keyring.map((k) => (revoke.has(k.key_id) ? { ...k, revoked: true } : k));
  const add = update.add_next;
  if (add && !out.some((k) => k.key_id === add.key_id)) out.push({ key_id: add.key_id, public_key: add.public_key, role: 'next' });
  return out;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}
