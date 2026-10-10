import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher, unlockerKey } from '../fetcher/replay.js';
import { collect, detailsUrl } from './registry.js';

export const COMPANY: CanonicalCompany = {
  company_id: '7b040439-0ed6-4a4e-b3ae-6ab1161b4e98',
  canonical_name: 'NORDVALE MATERIALS INC.',
  jurisdiction: 'OH',
  registry_id: '2447113',
  aliases: ['NORDVALE MATERIALS', 'NORDVALE MATERIALS LLC'],
  domains: ['nordvale.example.com'],
};

export const DEPS: CollectorDeps = {
  fetcher: new ReplayFetcher({}, 'fixtures'),
  now: () => '2026-10-10T19:42:11Z',
  runId: 'run-nordvale-registry',
};

function deps(map: Record<string, string>): CollectorDeps {
  return { ...DEPS, fetcher: new ReplayFetcher(map, 'fixtures') };
}

describe('registry collector', () => {
  it('parses a healthy details page', async () => {
    const env = await collect(
      COMPANY,
      deps({ [unlockerKey(detailsUrl(COMPANY))]: 'registry/details-healthy.html' }),
    );
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);
    expect(env.source).toBe('registry');
    expect(env.source_url).toBe(detailsUrl(COMPANY));
    expect(env.credits_spent).toBe(1);

    const status = env.items.find((i) => i.key === 'status:current');
    expect(status?.value).toBe('Active');

    const officer = env.items.find((i) => i.key === 'officer:jane-doe:cfo');
    expect(officer).toMatchObject({ type: 'officer', name: 'JANE DOE', role: 'CFO', since: '02/01/2024' });
    // key identifies the record, not the value
    expect(env.items.some((i) => i.key.includes('active'))).toBe(false);

    const filings = env.items.filter((i) => i.type === 'filing');
    expect(filings.map((f) => f.key).sort()).toEqual([
      'filing:201910208841',
      'filing:202415509822',
      'filing:202509104771',
    ]);

    expect(env.items.find((i) => i.key === 'address:registered')?.value).toContain('Columbus, OH');
    expect(env.items.find((i) => i.key === 'prior_name:nordvale-materials-llc')).toBeTruthy();
    expect(env.raw_excerpt).toContain('JANE DOE');
    expect(env.raw_excerpt).toContain('Active');
  });

  it('returns ok with no items for a not-found entity', async () => {
    const env = await collect(
      COMPANY,
      deps({ [unlockerKey(detailsUrl(COMPANY))]: 'registry/details-not-found.html' }),
    );
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);
    expect(env.items).toEqual([]);
    expect(env.error).toBeNull();
    expect(env.raw_excerpt).toContain('No entity found');
  });

  it('fails honestly on a blocked page and never throws', async () => {
    const env = await collect(
      COMPANY,
      deps({ [unlockerKey(detailsUrl(COMPANY))]: 'registry/blocked.html' }),
    );
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(false);
    expect(env.error).toBeTruthy();
    expect(env.items).toEqual([]);
    expect(env.raw_excerpt).toBe('');
  });

  it('fails honestly when the fetch itself errors', async () => {
    const env = await collect(COMPANY, deps({})); // no fixture -> fetcher throws
    expect(env.ok).toBe(false);
    expect(env.error).toContain('no fixture');
  });
});
