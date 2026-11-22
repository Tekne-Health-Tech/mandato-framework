/** Return entries sorted by token name for byte-stable output. */
const sortedEntries = (value) => Object.entries(value).sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1));

const colors = (palette, indent = '  ') =>
  sortedEntries(palette).map(([name, value]) => `${indent}--color-${name}: ${value};`).join('\n');

/** Convert validated theme tokens to CSS custom properties. */
export function toCss(tokens) {
  const common = [
    `  --font-display: ${tokens.typography.display.family};`,
    `  --font-body: ${tokens.typography.body.family};`,
    ...tokens.typography.scale.map((value, i) => `  --font-size-${i}: ${value}px;`),
    ...tokens.radius.map((value, i) => `  --radius-${i}: ${value}px;`),
    ...tokens.spacing.map((value, i) => `  --space-${i}: ${value}px;`),
  ];
  const dark = colors(tokens.color.dark, '    ');

  return `:root {\n${colors(tokens.color.light)}\n${common.join('\n')}\n}\n\n` +
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme=light]) {\n${dark}\n  }\n}\n\n` +
    `:root[data-theme=dark] {\n${colors(tokens.color.dark)}\n}\n`;
}
