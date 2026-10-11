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
  /** Base URL for non-/request Bright Data APIs (datasets). */
  apiBase?: string;
  /** Milliseconds between dataset snapshot progress polls. */
  pollIntervalMs?: number;
  /** Give up on a dataset snapshot after this many progress polls. */
  maxPolls?: number;
  /** Retries AFTER the first attempt, for transient refusals only. Default 2. */
  maxRetries?: number;
  /** Base backoff; attempt n waits backoffMs * 2^(n-1). Default 500ms. */
  backoffMs?: number;
  now?: () => Date;
}

/**
 * Bright Data refuses by policy and fails to render with the SAME shape: HTTP
 * 200, often an empty body, reason in `x-brd-*` headers, `x-brd-status-code:
 * 502` either way. They are not the same failure. A government domain stays
 * blocked forever and must never be retried; `expect_element` ("waiting for
 * selector \"#main\" failed") is their browser giving up on a page that
 * renders on the next attempt -- observed live on a Google SERP, 2026-10-11.
 *
 * So the code and message do the sorting, not the status.
 */
const POLICY_SIGNS = [
  'classified as government',
  'blocked by bright data',
  'usage policy',
  'robots.txt',
  'not available for immediate residential',
  'kyc',
];

export function classifyBrdError(error: string, code: string | null): 'policy' | 'transient' {
  const haystack = `${error} ${code ?? ''}`.toLowerCase();
  return haystack.includes('policy_') || POLICY_SIGNS.some((s) => haystack.includes(s))
    ? 'policy'
    : 'transient';
}

export class LiveFetcher implements Fetcher {
  private apiKey: string;
  private unlockerZone: string;
  private serpZone: string;
  private cacheDir?: string;
  private endpoint: string;
  private apiBase: string;
  private pollIntervalMs: number;
  private maxPolls: number;
  private maxRetries: number;
  private backoffMs: number;
  private now: () => Date;
  private mem = new Map<string, FetchResult>();

  constructor(opts: LiveFetcherOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.BRIGHTDATA_API_KEY ?? '';
    this.unlockerZone = opts.unlockerZone ?? process.env.BRIGHTDATA_UNLOCKER_ZONE ?? '';
    this.serpZone = opts.serpZone ?? process.env.BRIGHTDATA_SERP_ZONE ?? '';
    this.cacheDir = opts.cacheDir;
    this.endpoint = opts.endpoint ?? 'https://api.brightdata.com/request';
    this.apiBase = opts.apiBase ?? 'https://api.brightdata.com';
    this.pollIntervalMs = opts.pollIntervalMs ?? 3_000;
    this.maxPolls = opts.maxPolls ?? 40;
    this.maxRetries = opts.maxRetries ?? 2;
    this.backoffMs = opts.backoffMs ?? 500;
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

  /**
   * Bright Data Marketplace Dataset API — NOT part of the contract Fetcher;
   * collectors feature-detect it. Still first-party Bright Data, so it keeps
   * the "everything goes through Bright Data" rule.
   *
   *   POST /datasets/filter {dataset_id, records_limit, filter:{name,operator,value}}
   *     -> {snapshot_id}
   *   GET  /datasets/v3/progress/<snapshot_id>   -> {status: ready|running|failed}
   *   GET  /datasets/v3/snapshot/<snapshot_id>?format=json -> [records]
   *
   * Billing is per returned record (marketplace CPM), not per call —
   * recordsLimit bounds it. Cached like /request calls by dataset+filter+day.
   */
  async dataset(
    datasetId: string,
    filter: { name: string; operator: string; value: string },
    recordsLimit = 100,
  ): Promise<FetchResult> {
    if (!this.apiKey) throw new Error('BRIGHTDATA_API_KEY is not set');
    const key = this.cacheKey(
      'dataset',
      `${datasetId}|${recordsLimit}|${JSON.stringify(filter)}`,
    );
    const hit = this.mem.get(key);
    if (hit) return { ...hit, cache_hit: true };

    const file = this.fileFor(key);
    if (file && existsSync(file)) {
      const cached: FetchResult = {
        body: readFileSync(file, 'utf8'),
        url: `dataset:${datasetId}`,
        fetched_at: this.now().toISOString(),
        credits_spent: 0,
        cache_hit: true,
      };
      this.mem.set(key, cached);
      return { ...cached };
    }

    const auth = { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
    const trigger = await fetch(`${this.apiBase}/datasets/filter`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ dataset_id: datasetId, records_limit: recordsLimit, filter }),
    });
    const triggerBody = await trigger.text();
    if (!trigger.ok) {
      throw new Error(`dataset filter failed: HTTP ${trigger.status} ${triggerBody.slice(0, 200)}`);
    }
    const snapshotId = (JSON.parse(triggerBody) as { snapshot_id?: string }).snapshot_id;
    if (!snapshotId) throw new Error(`dataset filter returned no snapshot_id: ${triggerBody.slice(0, 200)}`);

    let status = '';
    for (let i = 0; i < this.maxPolls; i++) {
      const prog = await fetch(`${this.apiBase}/datasets/v3/progress/${snapshotId}`, {
        headers: { Authorization: auth.Authorization },
      });
      status = (((await prog.json()) as { status?: string }).status ?? '').toLowerCase();
      if (status === 'ready') break;
      if (status === 'failed' || status === 'canceled') {
        throw new Error(`dataset snapshot ${snapshotId} ${status}`);
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
    if (status !== 'ready') throw new Error(`dataset snapshot ${snapshotId} not ready after ${this.maxPolls} polls`);

    const dl = await fetch(`${this.apiBase}/datasets/v3/snapshot/${snapshotId}?format=json`, {
      headers: { Authorization: auth.Authorization },
    });
    const body = await dl.text();
    if (!dl.ok) throw new Error(`dataset snapshot download failed: HTTP ${dl.status} ${body.slice(0, 200)}`);

    const result: FetchResult = {
      body,
      url: `dataset:${datasetId}`,
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

    let body = '';
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, this.backoffMs * 2 ** (attempt - 1)));
      }

      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ zone, url: target, format: 'raw' }),
      });
      body = await res.text();

      // Bright Data can REFUSE a target (e.g. government domains it will not
      // fetch by policy) and still return HTTP 200 — often with a zero-byte
      // body — carrying the real failure only in x-brd-* response headers.
      // Treating that as an empty page is a silent false negative, so every
      // x-brd-error throws; but a render failure throws only once the retries
      // are gone, and says which kind of failure it was.
      const brdError = res.headers.get('x-brd-error');
      if (brdError) {
        const code = res.headers.get('x-brd-error-code');
        const upstream = res.headers.get('x-brd-status-code');
        const detail =
          `x-brd-error: "${brdError}"` +
          (code || upstream
            ? ` (x-brd-error-code: ${code ?? '?'}, x-brd-status-code: ${upstream ?? '?'})`
            : '');
        if (classifyBrdError(brdError, code) === 'policy') {
          throw new Error(`Bright Data refused ${resultUrl} — ${detail}`);
        }
        if (attempt >= this.maxRetries) {
          throw new Error(
            `Bright Data could not fetch ${resultUrl} in ${attempt + 1} attempt(s) — ${detail}. ` +
              'Their fetch failed; the target is not blocked by policy.',
          );
        }
        continue;
      }
      if (!res.ok) throw new Error(`Bright Data request failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      break;
    }

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
