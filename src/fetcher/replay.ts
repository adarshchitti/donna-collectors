import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fetcher, FetchResult } from '../contract.js';

/**
 * Fixture-backed Fetcher so the whole suite runs offline and deterministically.
 *
 * Map keys identify the request exactly:
 *   'unlocker:<absolute url>'  -> path to a saved HTML/text body
 *   'serp:<query>'             -> path to a saved SERP JSON body
 *
 * A missing key throws — a collector must turn that into {ok:false}, which is
 * also how tests exercise the fetch-failure path.
 */
export type ReplayMap = Record<string, string>;

export function serpKey(query: string): string {
  return `serp:${query}`;
}
export function unlockerKey(url: string): string {
  return `unlocker:${url}`;
}

export class ReplayFetcher implements Fetcher {
  constructor(
    private map: ReplayMap,
    private root: string,
    private fetchedAt = '2026-10-10T19:42:11Z',
    private creditsSpent = 1,
  ) {}

  async unlocker(url: string): Promise<FetchResult> {
    return this.load(unlockerKey(url), url);
  }

  async serp(query: string, _opts: { gl?: string; hl?: string } = {}): Promise<FetchResult> {
    return this.load(serpKey(query), `serp:${query}`);
  }

  private load(key: string, url: string): Promise<FetchResult> {
    const rel = this.map[key];
    if (!rel) return Promise.reject(new Error(`replay: no fixture for ${key}`));
    return Promise.resolve({
      body: readFileSync(join(this.root, rel), 'utf8'),
      url,
      fetched_at: this.fetchedAt,
      credits_spent: this.creditsSpent,
      cache_hit: false,
    });
  }
}
