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

/**
 * Markers specific enough to be conclusive wherever they appear. These are
 * strings no ordinary page carries by accident.
 */
const STRONG_BLOCK_MARKERS = [
  'cf-chl-',
  'px-captcha',
  'cf-browser-verification',
  'challenge-platform',
  'pardon our interruption',
  'are you a robot',
  'verify you are a human',
  'enable javascript and cookies to continue',
];

/**
 * Markers that appear on plenty of LEGITIMATE pages and so prove nothing on
 * their own: a contact form mentions reCAPTCHA, a CDN URL mentions Cloudflare,
 * a support article mentions "access denied". They only count when the page
 * also LOOKS like a challenge -- see assertUnblocked.
 *
 * Scanning for bare 'captcha' used to be enough to fail a fetch, and it threw
 * away a 581KB Goodyear homepage titled "Shop For Tires Online" because the
 * word appeared once in a script. That cost the data AND the credit, and made
 * coverage look worse than it was.
 */
const WEAK_BLOCK_MARKERS = [
  'captcha',
  'cloudflare',
  'access denied',
  'unusual traffic',
  'request blocked',
  'bot detection',
  '403 forbidden',
  'temporarily blocked',
];

/** Titles a challenge page actually uses. */
const BLOCK_TITLES = [
  'just a moment',
  'attention required',
  'access denied',
  'security check',
  'are you a robot',
  'access to this page has been denied',
  'one more step',
];

/**
 * A challenge page is SMALL. Real content pages run to hundreds of kilobytes;
 * an interstitial is a few. Used only to corroborate a weak marker, never alone.
 *
 * Measured, not guessed. At 40_000 this discarded 16 consecutive real
 * homepages that came back 36-37KB with reCAPTCHA referenced in a script --
 * the whole `domain` source read as blocked for a day. A Cloudflare "Just a
 * moment" interstitial is 2-15KB, so 12_000 keeps the corroboration useful
 * and puts an ordinary small homepage out of its reach. Real challenge pages
 * above this size are still caught by their markers and titles, which is what
 * actually identifies them; size was only ever the corroborating signal.
 */
const CHALLENGE_MAX_BYTES = 12_000;

export class BlockedError extends Error {
  constructor(marker: string) {
    super(`blocked or challenge page detected (${marker})`);
    this.name = 'BlockedError';
  }
}

/**
 * Throw when an unlocked body looks like a block/challenge page rather than the
 * real page. A 200 status does not mean content -- challenge pages are served
 * with 200 -- so every collector must call this before parsing.
 *
 * Three independent signals, deliberately ordered cheapest-first:
 *   1. a strong marker, conclusive anywhere;
 *   2. a challenge title, conclusive because titles are short and deliberate;
 *   3. a weak marker on a SMALL page -- the word plus the shape.
 *
 * Getting this wrong is expensive in both directions: too strict discards real
 * pages and the credits spent fetching them, and too loose parses an
 * interstitial as if it were the counterparty's record.
 */
export function assertUnblocked(body: string): void {
  if (body.trim().length === 0) throw new BlockedError('empty body');

  const head = body.slice(0, 50_000).toLowerCase();

  for (const m of STRONG_BLOCK_MARKERS) {
    if (head.includes(m)) throw new BlockedError(m);
  }

  const title = /<title[^>]*>([^<]{0,120})</i.exec(head)?.[1]?.trim() ?? '';
  for (const t of BLOCK_TITLES) {
    if (title.includes(t)) throw new BlockedError(`title: ${t}`);
  }

  if (body.length <= CHALLENGE_MAX_BYTES) {
    for (const m of WEAK_BLOCK_MARKERS) {
      if (head.includes(m)) throw new BlockedError(`${m} on a ${body.length}-byte page`);
    }
  }
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
    // Say what actually arrived. "was not JSON" sent a day of SERP failures
    // to the wrong diagnosis: the zone returns JSON correctly, and every one
    // of those bodies was a transient timeout or refusal wearing a parse
    // error. A collector that hides its own cause is the failure this product
    // exists to report.
    throw new Error(
      `SERP response was not JSON: ${trimmed.length} bytes` +
        (trimmed.length === 0
          ? ' (empty body -- a refusal or a timeout, not a parse problem)'
          : `, beginning ${JSON.stringify(trimmed.slice(0, 120))}`),
    );
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
