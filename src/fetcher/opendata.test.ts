import { describe, it, expect } from 'vitest';
import { fetchOpenData, isOpenDataUrl, OPEN_DATA_HOSTS, OpenDataFetchError } from './opendata.js';

const ok = (body: string) => (async () => ({ ok: true, status: 200, text: async () => body })) as never;

describe('the allowlist is the whole scope of the exception', () => {
  it('admits only the hosts Bright Data refuses as government', () => {
    expect(isOpenDataUrl('https://sanctionslistservice.ofac.treas.gov/x.csv')).toBe(true);
    expect(isOpenDataUrl('https://jfs.ohio.gov/warn')).toBe(true);
    expect(isOpenDataUrl('https://data.sec.gov/submissions/CIK1.json')).toBe(true);
  });

  it('refuses anything else, so this cannot widen into a general bypass', async () => {
    expect(isOpenDataUrl('https://www.google.com/search?q=x')).toBe(false);
    expect(isOpenDataUrl('https://biglots.com')).toBe(false);
    await expect(fetchOpenData('https://biglots.com')).rejects.toThrow(/not on the open-data allowlist/);
  });

  it('records WHY each host is permitted, not just that it is', () => {
    for (const reason of Object.values(OPEN_DATA_HOSTS)) {
      expect(reason).toMatch(/Bright Data blocks/);
    }
  });
});

describe('provenance is reported, never hidden', () => {
  it('marks the result as a direct fetch', async () => {
    const r = await fetchOpenData('https://data.sec.gov/x.json', { fetchImpl: ok('{"a":1}') });
    expect(r.via).toBe('direct');
  });

  it('reports zero credits, because no Bright Data request was made', async () => {
    const r = await fetchOpenData('https://data.sec.gov/x.json', { fetchImpl: ok('{"a":1}') });
    expect(r.credits_spent).toBe(0);
  });
});

describe('failures are explicit', () => {
  it('an empty body is an error, not an empty result', async () => {
    await expect(fetchOpenData('https://data.sec.gov/x.json', { fetchImpl: ok('   ') }))
      .rejects.toThrow(/empty body/);
  });

  it('a non-200 names the status', async () => {
    const bad = (async () => ({ ok: false, status: 503, text: async () => '' })) as never;
    await expect(fetchOpenData('https://data.sec.gov/x.json', { fetchImpl: bad }))
      .rejects.toThrow(/HTTP 503/);
  });
});
