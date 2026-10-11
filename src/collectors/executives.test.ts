import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher, serpKey, unlockerKey } from '../fetcher/replay.js';
import { collect, execQuery } from './executives.js';

const COMPANY: CanonicalCompany = {
  company_id: 'bbw-001',
  canonical_name: 'Bath & Body Works',
  jurisdiction: 'US',
  registry_id: '',
  aliases: ['BATH & BODY WORKS, INC.'],
  domains: ['bbwinc.com'],
};

const DEPS = { now: () => '2026-10-10T19:42:11Z', runId: 'run-bbw-executives' };
const deps = (map: Record<string, string>): CollectorDeps => ({
  ...DEPS,
  fetcher: new ReplayFetcher(map, 'fixtures'),
});

// serp-healthy.json is a REAL SERP capture (2026-10-10, serp_api1, gl=us&hl=en);
// the unlocked press release is authored HTML.
const HEALTHY = {
  [serpKey(execQuery(COMPANY))]: 'executives/serp-healthy.json',
  [unlockerKey('https://investors.bbwinc.com/news-releases/news-release-details/bath-body-works-appoints-daniel-heaf-chief-executive-officer')]:
    'executives/pr-healthy.html',
};

describe('executives collector', () => {
  it('extracts the move once and dedupes syndicated rephrasings by key', async () => {
    const env = await collect(COMPANY, deps(HEALTHY));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);
    expect(env.source).toBe('executives');

    // the real SERP carries the same move under "Appoints ... as Chief
    // Executive Officer" (bbwinc, linkedin) and "Names Daniel Heaf CEO"
    // (wwd, insideretail) — all collapse to ONE record key
    const keys = env.items.map((i) => i.key);
    expect(keys).toEqual(['move:daniel-heaf:ceo:undated']);

    const heaf = env.items[0]!;
    expect(heaf).toMatchObject({
      person: 'Daniel Heaf',
      role: 'Chief Executive Officer',
      kind: 'appointment',
      date: 'undated',
      url: 'https://investors.bbwinc.com/news-releases/news-release-details/bath-body-works-appoints-daniel-heaf-chief-executive-officer',
    });

    // no garbage persons: "Insider as Interim" / "New CEO" must not become items
    expect(env.items.some((i) => String(i.person).includes(' as'))).toBe(false);

    // press-release body lands in raw_excerpt verbatim
    expect(env.raw_excerpt).toContain('has appointed Daniel Heaf as');
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
