import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher, serpKey, unlockerKey } from '../fetcher/replay.js';
import { collect, execQuery } from './executives.js';

const COMPANY: CanonicalCompany = {
  company_id: '7b040439-0ed6-4a4e-b3ae-6ab1161b4e98',
  canonical_name: 'NORDVALE MATERIALS INC.',
  jurisdiction: 'OH',
  registry_id: '2447113',
  aliases: ['NORDVALE MATERIALS'],
  domains: ['nordvale.example.com'],
};

const DEPS = { now: () => '2026-10-10T19:42:11Z', runId: 'run-nordvale-executives' };
const deps = (map: Record<string, string>): CollectorDeps => ({
  ...DEPS,
  fetcher: new ReplayFetcher(map, 'fixtures'),
});

const HEALTHY = {
  [serpKey(execQuery(COMPANY))]: 'executives/serp-healthy.json',
  [unlockerKey('https://www.prnewswire.com/news-releases/nordvale-materials-names-jane-doe-chief-financial-officer-302034567.html')]:
    'executives/pr-healthy.html',
};

describe('executives collector', () => {
  it('extracts appointments and departures into stable move keys', async () => {
    const env = await collect(COMPANY, deps(HEALTHY));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);
    expect(env.source).toBe('executives');

    const keys = env.items.map((i) => i.key).sort();
    expect(keys).toEqual([
      'move:jane-doe:chief-financial-officer:2024-02-01',
      'move:marcus-hall:chief-operating-officer:2025-08-15',
      'move:priya-raghavan:chief-technology-officer:2022-07-18',
    ]);

    const doe = env.items.find((i) => i.key.startsWith('move:jane-doe'))!;
    expect(doe).toMatchObject({ person: 'Jane Doe', kind: 'appointment', role: 'Chief Financial Officer' });
    const hall = env.items.find((i) => i.key.startsWith('move:marcus-hall'))!;
    expect(hall.kind).toBe('departure');

    // press-release body lands in raw_excerpt verbatim
    expect(env.raw_excerpt).toContain('appointment of Jane Doe as Chief Financial Officer');
    expect(env.credits_spent).toBe(2);
  });

  it('returns ok with no items on an empty SERP', async () => {
    const env = await collect(COMPANY, deps({
      [serpKey(execQuery(COMPANY))]: 'news/serp-empty.json',
    }));
    expect(env.ok).toBe(true);
    expect(env.items).toEqual([]);
  });

  it('fails honestly when the SERP zone returns the unsupported-target body', async () => {
    const env = await collect(COMPANY, deps({
      [serpKey(execQuery(COMPANY))]: 'news/serp-unsupported.txt',
    }));
    expect(env.ok).toBe(false);
    expect(env.error).toBeTruthy();
    expect(env.items).toEqual([]);
    expect(env.raw_excerpt).toBe('');
  });
});
