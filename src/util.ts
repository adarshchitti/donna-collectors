import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { CanonicalCompany, CollectorDeps, CollectorEnvelope, Item, Source } from './contract.js';

/** Lowercase slug: "Jane M. Doe" -> "jane-m-doe". Used inside item keys. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/**
 * Normalized headline for syndication collapse: lowercase, punctuation
 * stripped, whitespace collapsed. The differ groups news items on this.
 */
export function headlineNorm(headline: string): string {
  return headline
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Success envelope. `fetched_at` always comes from the injected clock. */
export function envelope(
  company: CanonicalCompany,
  source: Source,
  deps: CollectorDeps,
  fields: { items: Item[]; raw_excerpt: string; source_url: string; credits_spent: number },
): CollectorEnvelope {
  return {
    company_id: company.company_id,
    source,
    fetched_at: deps.now(),
    run_id: deps.runId,
    ok: true,
    error: null,
    items: fields.items,
    raw_excerpt: fields.raw_excerpt,
    source_url: fields.source_url,
    credits_spent: fields.credits_spent,
  };
}

const BLOCK_MARKERS = [
  'captcha',
  'access denied',
  'unusual traffic',
  'pardon our interruption',
  'px-captcha',
  'cf-chl-',
  'cloudflare',
  'request blocked',
  'bot detection',
  'are you a robot',
  'verify you are a human',
  '403 forbidden',
  'temporarily blocked',
];

export class BlockedError extends Error {
  constructor(marker: string) {
    super(`blocked or challenge page detected (${marker})`);
    this.name = 'BlockedError';
  }
}

/**
 * Throw when an unlocked body looks like a block/challenge page rather than
 * the real page. A 200 status does not mean content — challenge pages are
 * served with 200 — so every collector must call this before parsing.
 */
export function assertUnblocked(body: string): void {
  const head = body.slice(0, 50_000).toLowerCase();
  for (const m of BLOCK_MARKERS) {
    if (head.includes(m)) throw new BlockedError(m);
  }
  if (body.trim().length === 0) throw new BlockedError('empty body');
}

export interface SerpResult {
  title: string;
  link: string;
  description: string;
  rank: number;
  date?: string;
}

/** Exact body the SERP zone returns (with HTTP 200) for a non-search URL. */
const SERP_UNSUPPORTED = "this target url isn't supported";

/** Parse the SERP zone's parsed-JSON response into organic results. */
export function parseSerp(body: string): SerpResult[] {
  const trimmed = body.trim();
  if (trimmed.toLowerCase().startsWith(SERP_UNSUPPORTED)) {
    throw new Error('SERP zone returned "target URL isn\'t supported" — wrong zone or non-search URL');
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new Error('SERP response was not JSON');
  }
  const organic = (json as { organic?: unknown }).organic;
  if (!Array.isArray(organic)) return [];
  const out: SerpResult[] = [];
  for (const r of organic) {
    const o = r as Record<string, unknown>;
    if (typeof o.link !== 'string' || typeof o.title !== 'string') continue;
    const item: SerpResult = {
      title: o.title,
      link: o.link,
      description: typeof o.description === 'string' ? o.description : '',
      rank: typeof o.rank === 'number' ? o.rank : out.length + 1,
    };
    if (typeof o.date === 'string') item.date = o.date;
    out.push(item);
  }
  return out;
}

/**
 * Visible text of the first nodes matching `selector`, whitespace collapsed.
 * Used to build raw_excerpt: verbatim page text, never a paraphrase.
 */
export function textAt(html: string, selector: string): string {
  const $ = load(html);
  const parts: string[] = [];
  $(selector).each((_i, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  });
  return parts.join(' ');
}

/** Whole-document visible text, whitespace collapsed. */
export function bodyText(html: string): string {
  const $ = load(html);
  $('script,style,noscript').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

/** First `n` chars of `s`, used to bound raw_excerpt length. */
export function clip(s: string, n = 4000): string {
  return s.length <= n ? s : s.slice(0, n);
}

/** True when `s` mentions the company by canonical name or any alias. */
export function nameMatches(company: CanonicalCompany, s: string): boolean {
  const hay = s.toLowerCase();
  return [company.canonical_name, ...company.aliases].some(
    (n) => n.length > 0 && hay.includes(n.toLowerCase()),
  );
}
