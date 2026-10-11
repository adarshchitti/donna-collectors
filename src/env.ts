/**
 * Credentials for a `--live` run, read from `.env` (or `.env.local`).
 *
 * Hand-parsed rather than `source`d or taken from a dotenv dependency: this
 * repo has two runtime deps on purpose, and a value here can contain `&` or
 * `#`, which a shell would mangle. Values are never printed -- the file exists
 * precisely so the key stays out of the transcript.
 *
 * Shell-provided variables win, so `BRIGHTDATA_API_KEY=... npm run collect`
 * keeps working exactly as it did before this file existed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

const REPO_ROOT = join(import.meta.dirname, '..');

/** Variables a live fetch cannot proceed without. */
export const LIVE_ENV_VARS = [
  'BRIGHTDATA_API_KEY',
  'BRIGHTDATA_UNLOCKER_ZONE',
  'BRIGHTDATA_SERP_ZONE',
] as const;

export function loadEnv(files: readonly string[] = ['.env', '.env.local']): void {
  for (const file of files) {
    const path = join(REPO_ROOT, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const m = LINE.exec(trimmed);
      if (!m || !m[1]) continue;
      let value = m[2]!.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}

/**
 * Stop before the first fetch when anything is missing.
 *
 * The zone variables are the ones that bite. A live run with no
 * BRIGHTDATA_UNLOCKER_ZONE starts happily, serves whatever is SERP-only, and
 * fails every source that unlocks a page -- registry, court, domain, and the
 * article half of news/executives/jobs -- with an error that reads like a
 * Bright Data outage rather than an unset variable.
 */
export function missingLiveEnv(): string[] {
  return LIVE_ENV_VARS.filter((name) => (process.env[name] ?? '').trim() === '');
}
