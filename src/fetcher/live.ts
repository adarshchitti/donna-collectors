import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fetcher, FetchResult } from '../contract.js';

/**
 * Live Bright Data fetcher. Bright Data is the ONLY fetch path — collectors
 * never call fetch() against a target site.
 *
 * POST https://api.brightdata.com/request
 *   Authorization: Bearer $BRIGHTDATA_API_KEY
 *   {"zone": <zone>, "url": <target>, "format": "raw"}
 *
 * Web Unlocker zone returns the page body; the SERP zone takes a search-engine
 * URL (geo MUST be pinned with gl=us&hl=en — a `country` body field is
 * silently ignored) and returns parsed JSON.
 *
 * Budget: 300 credits for the whole event. Every response is cached by
 * zone + URL + UTC day so a same-day re-run costs zero.
 */
export interface LiveFetcherOptions {
  apiKey?: string;
  unlockerZone?: string;
  serpZone?: string;
  /** Filesystem cache directory. Omit for in-memory caching only. */
  cacheDir?: string;
  endpoint?: string;
  now?: () => Date;
}

export class LiveFetcher implements Fetcher {
  private apiKey: string;
  private unlockerZone: string;
  private serpZone: string;
  private cacheDir?: string;
  private endpoint: string;
  private now: () => Date;
  private mem = new Map<string, FetchResult>();

  constructor(opts: LiveFetcherOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.BRIGHTDATA_API_KEY ?? '';
    this.unlockerZone = opts.unlockerZone ?? process.env.BRIGHTDATA_UNLOCKER_ZONE ?? '';
    this.serpZone = opts.serpZone ?? process.env.BRIGHTDATA_SERP_ZONE ?? '';
    this.cacheDir = opts.cacheDir;
    this.endpoint = opts.endpoint ?? 'https://api.brightdata.com/request';
    this.now = opts.now ?? (() => new Date());
  }

  /** Web Unlocker: any ordinary page. Throws if the zone is not configured. */
  async unlocker(url: string): Promise<FetchResult> {
    if (!this.unlockerZone) {
      throw new Error('BRIGHTDATA_UNLOCKER_ZONE is not set — Web Unlocker zone does not exist yet');
    }
    return this.request(this.unlockerZone, url, url);
  }

  /** SERP API: a search query. Geo is pinned in the URL; defaults to US/EN. */
  async serp(query: string, opts: { gl?: string; hl?: string } = {}): Promise<FetchResult> {
    if (!this.serpZone) throw new Error('BRIGHTDATA_SERP_ZONE is not set');
    const gl = opts.gl ?? 'us';
    const hl = opts.hl ?? 'en';
    const target =
      `https://www.google.com/search?q=${encodeURIComponent(query)}` +
      `&gl=${encodeURIComponent(gl)}&hl=${encodeURIComponent(hl)}`;
    return this.request(this.serpZone, target, target);
  }

  private cacheKey(zone: string, target: string): string {
    const day = this.now().toISOString().slice(0, 10); // UTC day
    return createHash('sha1').update(`${zone}|${day}|${target}`).digest('hex');
  }

  private fileFor(key: string): string | undefined {
    return this.cacheDir ? join(this.cacheDir, `${key}.body`) : undefined;
  }

  private async request(zone: string, target: string, resultUrl: string): Promise<FetchResult> {
    const key = this.cacheKey(zone, target);
    const hit = this.mem.get(key);
    if (hit) return { ...hit, cache_hit: true };

    const file = this.fileFor(key);
    if (file && existsSync(file)) {
      const cached: FetchResult = {
        body: readFileSync(file, 'utf8'),
        url: resultUrl,
        fetched_at: this.now().toISOString(),
        credits_spent: 0,
        cache_hit: true,
      };
      this.mem.set(key, cached);
      return { ...cached };
    }

    if (!this.apiKey) throw new Error('BRIGHTDATA_API_KEY is not set');

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ zone, url: target, format: 'raw' }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Bright Data request failed: HTTP ${res.status} ${body.slice(0, 200)}`);

    const result: FetchResult = {
      body,
      url: resultUrl,
      fetched_at: this.now().toISOString(),
      credits_spent: 1,
      cache_hit: false,
    };
    this.mem.set(key, result);
    if (file) {
      mkdirSync(this.cacheDir as string, { recursive: true });
      writeFileSync(file, body);
    }
    return result;
  }
}
