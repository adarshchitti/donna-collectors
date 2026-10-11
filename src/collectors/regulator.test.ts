import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher } from '../fetcher/replay.js';
import { collect } from './regulator.js';

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

describe('regulator collector', () => {
  it('fails visibly: both sub-sources are government domains Bright Data refuses', async () => {
    const env = await collect(COMPANY, deps({}));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(false);
    expect(env.error).toContain('unavailable');
    expect(env.error).toContain('government domains');
    expect(env.error).toContain('elicense.ohio.gov');
    expect(env.error).toContain('treas.gov');
    expect(env.items).toEqual([]);
    expect(env.raw_excerpt).toBe('');
    // never even attempts a fetch — a refused call is a wasted credit
    expect(env.credits_spent).toBe(0);
  });
});
