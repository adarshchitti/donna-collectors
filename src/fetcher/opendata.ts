import type { FetchResult } from '../contract.js';

/**
 * Open-data sources fetched DIRECTLY, not through Bright Data.
 *
 * Bright Data refuses every government domain by policy -- "classified as
 * Government and blocked" -- and it refuses them as HTTP 200 with an empty body,
 * which is why the fetcher checks the x-brd-error header. That removes all four
 * primary sources at a stroke: the state registry, the county court, the state
 * WARN notices, and OFAC.
 *
 * Two of those have non-government substitutes and now use them: the registry
 * via OpenCorporates and the court via CourtListener, both through Bright Data.
 * The remaining two do not. OFAC and the state WARN listings publish BULK FILES
 * intended for programmatic download -- OFAC's SDN.CSV is a documented export,
 * not a page anyone scrapes -- so they are fetched directly here.
 *
 * This is a deliberate, narrow exception to "Bright Data is the only fetch
 * path", and it is recorded rather than hidden: every result carries
 * `via: 'direct'`, so a run that used it says so and the evidence page can show
 * where the bytes came from. The alternative was claiming sanctions coverage we
 * could not actually obtain, which this product must never do.
 *
 * Scope is closed by an allowlist. Anything not on it still goes through
 * Bright Data, so this cannot quietly widen into a general bypass.
 */

/** Hosts permitted a direct fetch, with the reason each one is here. */
export const OPEN_DATA_HOSTS: Record<string, string> = {
  'sanctionslistservice.ofac.treas.gov':
    'OFAC publishes the SDN list as a bulk CSV export for programmatic use; Bright Data blocks the domain as government.',
  'jfs.ohio.gov':
    'Ohio JFS publishes WARN notices as a published listing; Bright Data blocks the domain as government.',
  'data.sec.gov':
    'SEC EDGAR is an official JSON API that permits programmatic access with a declared user agent; Bright Data blocks sec.gov as government.',
};

/**
 * SEC and OFAC both ask for a contactable user agent. Sending one is a
 * condition of their access policies, not decoration.
 */
const USER_AGENT =
  process.env.DONNA_CONTACT_UA
  ?? 'Donna counterparty-monitoring (contact: set DONNA_CONTACT_UA)';

export class OpenDataFetchError extends Error {
  constructor(url: string, detail: string) {
    super(`open-data fetch of ${url} failed: ${detail}`);
    this.name = 'OpenDataFetchError';
  }
}

export function isOpenDataUrl(url: string): boolean {
  try {
    return Object.hasOwn(OPEN_DATA_HOSTS, new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Fetch an allowlisted open-data URL directly.
 *
 * `credits_spent` is 0 because no Bright Data request was made -- reporting
 * otherwise would overstate the spend and misstate how the bytes were obtained.
 */
export async function fetchOpenData(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<FetchResult & { via: 'direct' }> {
  if (!isOpenDataUrl(url)) {
    throw new OpenDataFetchError(url, 'host is not on the open-data allowlist');
  }

  const impl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);
  try {
    const res = await impl(url, {
      // These endpoints redirect to a CDN; without following it the body is empty.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      signal: controller.signal,
    });
    if (!res.ok) throw new OpenDataFetchError(url, `HTTP ${res.status}`);
    const body = await res.text();
    if (body.trim().length === 0) throw new OpenDataFetchError(url, 'empty body');
    return {
      body,
      url,
      fetched_at: new Date().toISOString(),
      credits_spent: 0,
      cache_hit: false,
      via: 'direct',
    };
  } catch (error) {
    if (error instanceof OpenDataFetchError) throw error;
    throw new OpenDataFetchError(
      url,
      controller.signal.aborted ? 'timed out' : error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}
