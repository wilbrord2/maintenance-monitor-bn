import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Reads the version from package.json (two levels above both src/config and dist/config). */
export function readAppVersion(): string {
  try {
    const raw = readFileSync(resolve(__dirname, '../../package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version;
    }
  } catch {
    // Fall through to the default below.
  }
  return '0.0.0';
}
