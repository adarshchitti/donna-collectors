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

const RESULT = { url: 'x', fetched_at: '2026-10-10T19:42:11Z', credits_spent: 1, cache_hit: false };

/** A ReplayFetcher that also answers dataset() calls like LiveFetcher does. */
class DatasetReplay extends ReplayFetcher {
  constructor(
    map: Record<string, string>,
    private records: Record<string, unknown>[] | Error,
  ) {
    super(map, 'fixtures');
  }
  async dataset() {
    if (this.records instanceof Error) throw this.records;
    return { ...RESULT, url: 'dataset:gd_l4dx9j9sscpvs7no2', body: JSON.stringify(this.records) };
  }
}

const INDEED_RECORDS = [
  { job_title: 'Senior Materials Scientist', company_name: 'Battelle', job_location: 'Columbus, OH', job_posted_date: '2026-09-28' },
  { job_title: 'Senior Materials Scientist', company_name: 'Battelle', job_location: 'Columbus, OH', job_posted_date: '2026-09-20' },
  { job_title: 'Laboratory Technician', company_name: 'Battelle', job_location: 'Columbus, OH', job_posted_date: '2026-09-25' },
  { job_title: 'Unrelated Role', company_name: 'Cardinal Health', job_posted_date: '2026-10-01' },
];

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

  it('prefers the Indeed dataset when the fetcher supports dataset()', async () => {
    const env = await collect(COMPANY, {
      ...DEPS,
      fetcher: new DatasetReplay({}, INDEED_RECORDS),
    });
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);

    const count = env.items.find((i) => i.key === 'jobs:count');
    expect(count).toMatchObject({ open_roles: 3, basis: 'indeed-dataset' });
    // duplicate postings collapse into one title record with a postings count
    expect(env.items.find((i) => i.key === 'jobs:title:senior-materials-scientist'))
      .toMatchObject({ type: 'job_title', postings: 2 });
    expect(env.items.filter((i) => i.type === 'job_title')).toHaveLength(2);
    // dataset currency travels on a meta item — never implied by fetched_at
    expect(env.items.find((i) => i.key === 'meta:dataset'))
      .toMatchObject({ as_of: '2026-09-28', matched: 3, records: 4 });
  });

  it('falls back to SERP when the dataset call fails, and says so', async () => {
    const env = await collect(COMPANY, {
      ...DEPS,
      fetcher: new DatasetReplay(
        {
          [serpKey(jobsQuery(COMPANY))]: 'jobs/serp-healthy.json',
          [unlockerKey('https://www.battelle.org/careers')]: 'jobs/careers-healthy.html',
        },
        new Error('dataset snapshot failed'),
      ),
    });
    expect(env.ok).toBe(true);
    expect(env.items.find((i) => i.key === 'jobs:count')).toMatchObject({ basis: 'careers-page' });
    const meta = env.items.find((i) => i.key === 'meta:dataset');
    expect(meta).toBeTruthy();
    expect(String(meta?.value)).toContain('unavailable');
  });
});
