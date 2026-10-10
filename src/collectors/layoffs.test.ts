import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher, unlockerKey } from '../fetcher/replay.js';
import { collect, warnUrl } from './layoffs.js';

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
  it('emits one item per WARN notice naming the company', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(warnUrl())]: 'layoffs/warn-healthy.html',
    }));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);
    // two rows name Nordvale; Kepler row is filtered out
    expect(env.items.map((i) => i.key).sort()).toEqual([
      'notice:NordvaleLicking-022026',
      'notice:NordvaleMaterials-091526',
    ]);
    const first = env.items.find((i) => i.key === 'notice:NordvaleMaterials-091526')!;
    expect(first).toMatchObject({
      notice_date: '09/15/2026',
      effective_date: '11/15/2026',
      employees_affected: 145,
    });
    expect(env.raw_excerpt).toContain('Employees Affected: 145');
  });

  it('returns ok with no items when no row names the company', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(warnUrl())]: 'layoffs/warn-empty.html',
    }));
    expect(env.ok).toBe(true);
    expect(env.items).toEqual([]);
  });

  it('fails honestly on a blocked page and never throws', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(warnUrl())]: '_shared/blocked.html',
    }));
    expect(env.ok).toBe(false);
    expect(env.items).toEqual([]);
    expect(env.raw_excerpt).toBe('');
  });
});
