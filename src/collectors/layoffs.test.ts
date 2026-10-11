import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher } from '../fetcher/replay.js';
import { collect } from './layoffs.js';

const COMPANY: CanonicalCompany = {
  company_id: '7b040439-0ed6-4a4e-b3ae-6ab1161b4e98',
  canonical_name: 'NORDVALE MATERIALS INC.',
  jurisdiction: 'OH',
  registry_id: '2447113',
  aliases: ['NORDVALE MATERIALS'],
  domains: ['nordvale.example.com'],
};

const DEPS = { now: () => '2026-10-10T19:42:11Z', runId: 'run-nordvale-layoffs' };
const deps = (map: Record<string, string>): CollectorDeps => ({
  ...DEPS,
  fetcher: new ReplayFetcher(map, 'fixtures'),
});

describe('layoffs collector', () => {
  it('fails visibly: Ohio JFS WARN is a government domain with no reachable substitute', async () => {
    const env = await collect(COMPANY, deps({}));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(false);
    expect(env.error).toContain('unavailable');
    expect(env.error).toContain('jfs.ohio.gov');
    expect(env.items).toEqual([]);
    expect(env.raw_excerpt).toBe('');
    expect(env.credits_spent).toBe(0);
  });
});
