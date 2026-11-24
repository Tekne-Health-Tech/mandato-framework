import nacl from 'tweetnacl';

interface Key {
  key_id: string;
  public_key: string;
  revoked?: boolean;
}

interface SignedManifest {
  expires_at: string;
  sig: { key_id: string; alg: string; value: string };
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function decodeBase64Url(value: string): Uint8Array {
  const output: number[] = [];
  let bits = 0;
  let buffer = 0;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('invalid base64url');
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(output);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value !== 'object') throw new Error('unsupported value');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export function verifyManifest(manifest: SignedManifest, keyring: Key[], now = new Date()): boolean {
  try {
    if (manifest.sig.alg !== 'Ed25519' || new Date(manifest.expires_at) <= now) return false;
    const key = keyring.find((entry) => entry.key_id === manifest.sig.key_id && !entry.revoked);
    if (!key) return false;
    const { sig, ...body } = manifest;
    return nacl.sign.detached.verify(
      new TextEncoder().encode(canonicalize(body)),
      decodeBase64Url(sig.value),
      decodeBase64Url(key.public_key.replace(/^ed25519:/, '')),
    );
  } catch {
    return false;
  }
}
