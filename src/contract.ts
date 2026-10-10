import { z } from 'zod';

/**
 * THE CONTRACT. This file is the only thing that crosses the collector
 * boundary, and it is fixed -- do not change it. Everything else in this repo
 * is yours.
 *
 * A collector is handed a canonical company and returns one envelope. It never
 * touches a database, a UI, or an orchestrator.
 */

export const SOURCES = [
  'registry', 'court', 'regulator', 'layoffs',
  'news', 'executives', 'jobs', 'domain',
] as const;
export const sourceSchema = z.enum(SOURCES);
export type Source = z.infer<typeof sourceSchema>;

/** Fixed per source. Primary outranks reported; inferred is the weakest. */
export const SOURCE_TRUST: Record<Source, 'primary' | 'reported' | 'inferred'> = {
  registry: 'primary', court: 'primary', regulator: 'primary', layoffs: 'primary',
  news: 'reported', executives: 'reported',
  jobs: 'inferred', domain: 'inferred',
};

/**
 * An item is one record observed at a source.
 *
 * `key` identifies the RECORD, never its value. If you mint
 * `registry:status:active`, then when the status changes the key changes too,
 * and the differ sees one record removed and a different one added rather than
 * one record ALTERED -- losing the previous value, which is the entire point.
 * Use `registry:status` and put `active` in `value`.
 *
 * `key` must also be stable across runs: no row indexes, no timestamps, nothing
 * that varies between two fetches of unchanged data.
 */
export const itemSchema = z.object({
  key: z.string().min(1),
  type: z.string().min(1),
}).passthrough();
export type Item = z.infer<typeof itemSchema>;

export const collectorEnvelopeSchema = z.object({
  company_id: z.string().min(1),
  source: sourceSchema,
  /** Full ISO instant. Shown to users as evidence metadata. */
  fetched_at: z.string().datetime({ offset: true }),
  run_id: z.string().min(1),
  ok: z.boolean(),
  error: z.string().nullable(),
  items: z.array(itemSchema),
  /**
   * THE EXACT TEXT a later claim will point to. Not a summary, not a paraphrase.
   * A user clicks through from a sentence in a briefing to this text to check
   * the claim themselves. If it is vague, the product's trust story breaks.
   */
  raw_excerpt: z.string(),
  /** The page a sceptical analyst can open for themselves. */
  source_url: z.string(),
  credits_spent: z.number().int().min(0),
});
export type CollectorEnvelope = z.infer<typeof collectorEnvelopeSchema>;

/** What a collector is given. */
export interface CanonicalCompany {
  company_id: string;
  canonical_name: string;
  /** Two-letter uppercase. */
  jurisdiction: string;
  registry_id: string;
  aliases: string[];
  domains: string[];
}

/**
 * Injected so the whole suite runs offline against saved fixtures. Bright Data
 * is the ONLY fetch path -- never call fetch() against a target site directly.
 */
export interface FetchResult {
  body: string;
  url: string;
  fetched_at: string;
  credits_spent: number;
  cache_hit: boolean;
}

export interface Fetcher {
  /** Web Unlocker: any ordinary page. */
  unlocker(url: string): Promise<FetchResult>;
  /** SERP API: a search-engine query. Returns PARSED JSON, not HTML. */
  serp(query: string, opts?: { gl?: string; hl?: string }): Promise<FetchResult>;
}

export interface CollectorDeps {
  fetcher: Fetcher;
  /** Injected so a replayed run is byte-identical. Never call Date.now(). */
  now: () => string;
  runId: string;
}

export type Collector = (
  company: CanonicalCompany,
  deps: CollectorDeps,
) => Promise<CollectorEnvelope>;

/**
 * Build a failure envelope. A collector NEVER throws: a thrown exception
 * becomes silence, and silence reads as "nothing happened" -- the single
 * failure mode this product exists to prevent. A failure is recorded and shown
 * to the user as a gap in coverage.
 */
export function failed(
  company: CanonicalCompany,
  source: Source,
  deps: CollectorDeps,
  error: unknown,
  source_url = '',
  credits_spent = 0,
): CollectorEnvelope {
  return {
    company_id: company.company_id,
    source,
    fetched_at: deps.now(),
    run_id: deps.runId,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    items: [],
    raw_excerpt: '',
    source_url,
    credits_spent,
  };
}
