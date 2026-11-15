// Normalization v1 for blind indexes (design 0001 §4.6). Must match workers/core/crypto/normalize.py byte for byte.
export class NormalizeError extends Error {}

export function email(value) {
  const s = value.trim();
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@') || at === s.length - 1) throw new NormalizeError('invalid');
  const local = s.slice(0, at).normalize('NFKC').toLowerCase();
  const domain = s.slice(at + 1).normalize('NFKC').toLowerCase();
  if (!/^[\x21-\x7e]+$/.test(domain)) throw new NormalizeError('non-ascii-domain');
  return `${local}@${domain}`;
}

export function phone(value) {
  const digits = value.replace(/\D/g, '');
  if (value.trim().startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return `+${digits}`;
  throw new NormalizeError('invalid');
}
