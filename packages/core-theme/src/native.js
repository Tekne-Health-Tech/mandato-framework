const camelCase = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

const colors = (palette) => Object.fromEntries(
  Object.entries(palette)
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
    .map(([name, value]) => [camelCase(name), value]),
);

/** Convert validated theme tokens to a React Native-compatible plain object. */
export function toNative(tokens) {
  return {
    light: { colors: colors(tokens.color.light) },
    dark: { colors: colors(tokens.color.dark) },
    typography: {
      display: { family: tokens.typography.display.family, ...(tokens.typography.display.file && { file: tokens.typography.display.file }) },
      body: { family: tokens.typography.body.family },
      scale: [...tokens.typography.scale],
    },
    radius: [...tokens.radius],
    spacing: [...tokens.spacing],
  };
}
