import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher, unlockerKey } from '../fetcher/replay.js';
import { collect, partySearchUrl } from './court.js';

const COMPANY: CanonicalCompany = {
  company_id: '7b040439-0ed6-4a4e-b3ae-6ab1161b4e98',
  canonical_name: 'NORDVALE MATERIALS INC.',
  jurisdiction: 'OH',
  registry_id: '2447113',
  aliases: ['NORDVALE MATERIALS'],
  domains: ['nordvale.example.com'],
};

const DEPS = { now: () => '2026-10-10T19:42:11Z', runId: 'run-nordvale-court' };
const deps = (map: Record<string, string>): CollectorDeps => ({
  ...DEPS,
  fetcher: new ReplayFetcher(map, 'fixtures'),
});

describe('court collector', () => {
  it('parses a healthy party-search page including the current-through date', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(partySearchUrl(COMPANY))]: 'court/party-search-healthy.html',
    }));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);

    const cases = env.items.filter((i) => i.type === 'case');
    expect(cases.map((c) => c.key)).toEqual([
      'case:26CV002147',
      'case:24CV008812',
      'case:25CV010455',
    ]);
    expect(cases[0]).toMatchObject({ docket_number: '26CV002147', role: 'Defendant', status: 'Open' });

    // the portal's own lag date is surfaced, not hidden
    const meta = env.items.find((i) => i.key === 'meta:current_through');
    expect(meta?.value).toBe('10/07/2026');
    expect(env.raw_excerpt).toContain('current through 10/07/2026');
  });

  it('returns ok with no case items on a zero-result page', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(partySearchUrl(COMPANY))]: 'court/party-search-empty.html',
    }));
    expect(env.ok).toBe(true);
    expect(env.items.filter((i) => i.type === 'case')).toEqual([]);
    // the currency date is still reported on an empty result
    expect(env.items.find((i) => i.key === 'meta:current_through')?.value).toBe('10/07/2026');
  });

  it('fails honestly on a blocked page and never throws', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(partySearchUrl(COMPANY))]: '_shared/blocked.html',
    }));
    expect(env.ok).toBe(false);
    expect(env.error).toBeTruthy();
    expect(env.items).toEqual([]);
    expect(env.raw_excerpt).toBe('');
  });
});
