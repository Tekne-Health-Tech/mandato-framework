// WCAG 2.x contrast check for design tokens (design 0001 §8).
const TEXT_PAIRS = [['fg', 'bg'], ['fg', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['link', 'bg'], ['link', 'surface'], ['brand-on', 'brand'], ['cta-on', 'cta']];
const UI_PAIRS = [['line', 'bg'], ['success', 'bg'], ['warning', 'bg'], ['error', 'bg'], ['info', 'bg']];

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Returns a list of failures; empty means the token set passes. */
export function checkContrast(tokens) {
  const failures = [];
  for (const mode of ['light', 'dark']) {
    const p = tokens.color[mode];
    for (const [pairs, min] of [[TEXT_PAIRS, 4.5], [UI_PAIRS, 3]]) {
      for (const [f, b] of pairs) {
        const r = ratio(p[f], p[b]);
        if (r < min) failures.push(`${mode}: ${f}/${b} = ${r.toFixed(2)} < ${min}`);
      }
    }
  }
  return failures;
}
