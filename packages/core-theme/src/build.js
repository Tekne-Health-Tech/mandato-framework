#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { checkContrast } from './contrast.js';
import { toCss } from './css.js';
import { toNative } from './native.js';

/** Build CSS and React Native theme files from one token file. */
export function build(tokensPath, outDir) {
  if (!tokensPath || !outDir) throw new Error('Usage: node packages/core-theme/src/build.js <tokens.json> <outDir>');

  const tokens = JSON.parse(readFileSync(resolve(tokensPath), 'utf8'));
  const schema = JSON.parse(readFileSync(new URL('../schema/tokens.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  if (!validate(tokens)) {
    throw new Error(`Token schema validation failed:\n${validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('\n')}`);
  }

  const failures = checkContrast(tokens);
  if (failures.length) throw new Error(`Token contrast check failed:\n${failures.join('\n')}`);

  mkdirSync(resolve(outDir), { recursive: true });
  writeFileSync(resolve(outDir, 'theme.css'), toCss(tokens));
  writeFileSync(resolve(outDir, 'theme.native.json'), `${JSON.stringify(toNative(tokens), null, 2)}\n`);
}

/** Run the CLI and return its process exit code. */
export function run(args, report = console.error) {
  try {
    build(...args);
    return 0;
  } catch (error) {
    report(error.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
