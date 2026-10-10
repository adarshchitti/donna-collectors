import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher, unlockerKey } from '../fetcher/replay.js';
import { collect, elicenseUrl, ofacUrl } from './regulator.js';

const COMPANY: CanonicalCompany = {
  company_id: '7b040439-0ed6-4a4e-b3ae-6ab1161b4e98',
  canonical_name: 'NORDVALE MATERIALS INC.',
  jurisdiction: 'OH',
  registry_id: '2447113',
  aliases: ['NORDVALE MATERIALS'],
  domains: ['nordvale.example.com'],
};

const DEPS = { now: () => '2026-10-10T19:42:11Z', runId: 'run-nordvale-regulator' };
const deps = (map: Record<string, string>): CollectorDeps => ({
  ...DEPS,
  fetcher: new ReplayFetcher(map, 'fixtures'),
});

const BOTH = {
  [unlockerKey(elicenseUrl(COMPANY))]: 'regulator/elicense-healthy.html',
  [unlockerKey(ofacUrl(COMPANY))]: 'regulator/ofac-healthy.html',
};

describe('regulator collector', () => {
  it('parses licenses, enforcement actions and SDN matches', async () => {
    const env = await collect(COMPANY, deps(BOTH));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);
    expect(env.credits_spent).toBe(2);

    expect(env.items.find((i) => i.key === 'licence:WPC.88421'))
      .toMatchObject({ status: 'Active', licence_type: 'HAZARDOUS MATERIALS TRANSPORT PERMIT' });
    expect(env.items.find((i) => i.key === 'action:ACT-2025-0149'))
      .toMatchObject({ action_type: 'NOTICE OF VIOLATION' });
    // the sanctions key names the MATCHED party, not the searched company
    expect(env.items.find((i) => i.key === 'sanctions:sdn:nordval-materials-trading-fze'))
      .toMatchObject({ list: 'SDN', score: '83' });
  });

  it('returns ok with no items when both lookups are empty', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(elicenseUrl(COMPANY))]: 'regulator/elicense-empty.html',
      [unlockerKey(ofacUrl(COMPANY))]: 'regulator/ofac-empty.html',
    }));
    expect(env.ok).toBe(true);
    expect(env.items).toEqual([]);
    expect(env.raw_excerpt).toContain('0 records');
  });

  it('fails the whole envelope when either sub-source is blocked', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(elicenseUrl(COMPANY))]: 'regulator/elicense-healthy.html',
      [unlockerKey(ofacUrl(COMPANY))]: '_shared/blocked.html',
    }));
    expect(env.ok).toBe(false);
    expect(env.error).toBeTruthy();
    expect(env.items).toEqual([]);
  });
});
