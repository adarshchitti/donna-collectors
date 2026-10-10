import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher, serpKey, unlockerKey } from '../fetcher/replay.js';
import { collect, jobsQuery } from './jobs.js';

const COMPANY: CanonicalCompany = {
  company_id: '7b040439-0ed6-4a4e-b3ae-6ab1161b4e98',
  canonical_name: 'Battelle',
  jurisdiction: 'OH',
  registry_id: '2447113',
  aliases: ['Battelle Memorial Institute'],
  domains: ['battelle.org'],
};

const DEPS = { now: () => '2026-10-10T19:42:11Z', runId: 'run-battelle-jobs' };
const deps = (map: Record<string, string>): CollectorDeps => ({
  ...DEPS,
  fetcher: new ReplayFetcher(map, 'fixtures'),
});

describe('jobs collector', () => {
  it('unlocks the careers page and emits count + title items', async () => {
    const env = await collect(COMPANY, deps({
      [serpKey(jobsQuery(COMPANY))]: 'jobs/serp-healthy.json',
      [unlockerKey('https://www.battelle.org/careers')]: 'jobs/careers-healthy.html',
    }));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);
    expect(env.source_url).toBe('https://www.battelle.org/careers');

    const count = env.items.find((i) => i.key === 'jobs:count');
    expect(count).toMatchObject({ open_roles: 4, basis: 'careers-page' });
    expect(env.items.some((i) => i.key === 'jobs:title:senior-materials-scientist')).toBe(true);
    expect(env.items.filter((i) => i.type === 'job_title')).toHaveLength(4);
  });

  it('reports an observed zero when the careers page lists no openings', async () => {
    const env = await collect(COMPANY, deps({
      [serpKey(jobsQuery(COMPANY))]: 'jobs/serp-healthy.json',
      [unlockerKey('https://www.battelle.org/careers')]: 'jobs/careers-empty.html',
    }));
    expect(env.ok).toBe(true);
    expect(env.items.find((i) => i.key === 'jobs:count')?.open_roles).toBe(0);
  });

  it('returns ok with no items on an empty SERP', async () => {
    const env = await collect(COMPANY, deps({
      [serpKey(jobsQuery(COMPANY))]: 'news/serp-empty.json',
    }));
    expect(env.ok).toBe(true);
    expect(env.items).toEqual([]);
  });

  it('fails honestly when the SERP zone returns the unsupported-target body', async () => {
    const env = await collect(COMPANY, deps({
      [serpKey(jobsQuery(COMPANY))]: 'news/serp-unsupported.txt',
    }));
    expect(env.ok).toBe(false);
    expect(env.items).toEqual([]);
    expect(env.raw_excerpt).toBe('');
  });
});
