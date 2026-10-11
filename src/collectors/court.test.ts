import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher, unlockerKey } from '../fetcher/replay.js';
import { collect, searchUrl } from './court.js';

const COMPANY: CanonicalCompany = {
  company_id: '7b040439-0ed6-4a4e-b3ae-6ab1161b4e98',
  canonical_name: 'Big Lots, Inc.',
  jurisdiction: 'OH',
  registry_id: '1215332',
  aliases: ['BIG LOTS', 'Big Lots Stores'],
  domains: ['biglots.com'],
};

const DEPS = { now: () => '2026-10-10T19:42:11Z', runId: 'run-biglots-court' };
const deps = (map: Record<string, string>): CollectorDeps => ({
  ...DEPS,
  fetcher: new ReplayFetcher(map, 'fixtures'),
});

describe('court collector (CourtListener)', () => {
  it('parses a real API capture: party rows become cases, mentions are dropped', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(searchUrl(COMPANY))]: 'court/courtlistener-search-biglots.json',
    }));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);
    expect(env.source).toBe('court');
    expect(env.source_url).toBe(searchUrl(COMPANY));

    // the API's own full-text hit count is surfaced honestly
    expect(env.items.find((i) => i.key === 'meta:result_count')?.value).toBe('4857');

    const cases = env.items.filter((i) => i.type === 'case');
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.key.startsWith('case:')).toBe(true);
      expect(typeof c.docket_number).toBe('string');
      expect(['open', 'stayed'].includes(String(c.status)) || String(c.status).startsWith('terminated'))
        .toBe(true);
    }
    // every kept row actually names the company — full-text mentions were dropped
    expect(cases.every((c) => /big lots/i.test(String(c.case_name) + (c.party as string[]).join(' ')))).toBe(true);
    // page 1 of this real response holds no bankruptcy docket
    expect(env.items.filter((i) => i.type === 'insolvency_filing')).toEqual([]);
    expect(env.raw_excerpt).toContain('v. Big Lots');
  });

  it('classifies a bankruptcy docket as insolvency_filing and a stayed case as stayed', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(searchUrl(COMPANY))]: 'court/courtlistener-search-insolvency.json',
    }));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);

    // the Chapter 11 petition is a distinct tier-1 type, not an ordinary case
    const bk = env.items.find((i) => i.type === 'insolvency_filing');
    expect(bk).toMatchObject({
      key: 'insolvency:deb:1:24-bk-11885',
      docket_number: '1:24-bk-11885',
      chapter: '11',
      court_id: 'deb',
      docket_type: 'Bankruptcy',
      status: 'open',
    });
    expect(bk?.docket_url).toBe('https://www.courtlistener.com/docket/69321123/big-lots-inc/');

    // a civil case reporting a stay stays a `case` — with 'stayed' in status
    const stayed = env.items.find((i) => i.key === 'case:ohsd:2:24-cv-01811');
    expect(stayed).toMatchObject({ type: 'case', court_id: 'ohsd' });
    expect(String(stayed?.status)).toContain('stayed');
    // a "suggestion of bankruptcy" on a civil docket is NOT an insolvency filing
    expect(env.items.filter((i) => i.type === 'insolvency_filing')).toHaveLength(1);

    expect(env.items.find((i) => i.key === 'case:pamd:1:24-cv-01162')?.status)
      .toBe('terminated 2025-01-30');
    expect(env.raw_excerpt).toContain('chapter 11');
  });

  it('returns ok with only the count item on a zero-result response', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(searchUrl(COMPANY))]: 'court/courtlistener-search-empty.json',
    }));
    expect(env.ok).toBe(true);
    expect(env.items.filter((i) => i.type === 'case')).toEqual([]);
    expect(env.items.find((i) => i.key === 'meta:result_count')?.value).toBe('0');
  });

  it('fails honestly when the fetch errors or the body is not JSON', async () => {
    const env = await collect(COMPANY, deps({}));
    expect(env.ok).toBe(false);
    expect(env.error).toContain('no fixture');

    const bad = await collect(COMPANY, deps({
      [unlockerKey(searchUrl(COMPANY))]: '_shared/blocked.html',
    }));
    expect(bad.ok).toBe(false);
    expect(bad.items).toEqual([]);
    expect(bad.raw_excerpt).toBe('');
  });
});
