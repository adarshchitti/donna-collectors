import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher, serpKey, unlockerKey } from '../fetcher/replay.js';
import { collect, newsQuery } from './news.js';

const COMPANY: CanonicalCompany = {
  company_id: '7b040439-0ed6-4a4e-b3ae-6ab1161b4e98',
  canonical_name: 'Battelle',
  jurisdiction: 'OH',
  registry_id: '2447113',
  aliases: ['Battelle Memorial Institute'],
  domains: ['battelle.org'],
};

const DEPS = {
  now: () => '2026-10-10T19:42:11Z',
  runId: 'run-battelle-news',
};

function deps(map: Record<string, string>): CollectorDeps {
  return { ...DEPS, fetcher: new ReplayFetcher(map, 'fixtures') };
}

const HEALTHY_MAP = {
  [serpKey(newsQuery(COMPANY))]: 'news/serp-healthy.json',
  [unlockerKey('https://www.battelle.org/insights/newsroom')]: 'news/article-newsroom.html',
  [unlockerKey('https://www.battelle.org/')]: 'news/article-homepage.html',
  [unlockerKey('https://inside.battelle.org/')]: 'news/article-blog.html',
};

describe('news collector', () => {
  it('runs SERP-then-unlock and emits article items with headline_norm', async () => {
    const env = await collect(COMPANY, deps(HEALTHY_MAP));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);
    expect(env.source).toBe('news');
    // 1 SERP + 3 article unlocks
    expect(env.credits_spent).toBe(4);
    expect(env.items).toHaveLength(6);

    const first = env.items[0]!;
    expect(first.key).toMatch(/^article:[0-9a-f]{40}$/);
    expect(first.headline_norm).toBe('newsroom');
    expect(first.unlocked).toBe(true);
    expect(first.body).toContain('Battelle Awarded $82 Million');
    expect(first.outlet).toBe('battelle.org');

    // beyond the unlock cap: still an observed item, marked not unlocked
    const tail = env.items.at(-1)!;
    expect(tail.unlocked).toBe(false);
    expect(tail.headline_norm).toBeTruthy();

    expect(env.raw_excerpt).toContain('=== https://www.battelle.org/insights/newsroom');
  });

  it('survives a single article being blocked', async () => {
    const env = await collect(COMPANY, deps({
      ...HEALTHY_MAP,
      [unlockerKey('https://www.battelle.org/insights/newsroom')]: 'registry/blocked.html',
    }));
    expect(env.ok).toBe(true);
    const blocked = env.items.find((i) => i.url === 'https://www.battelle.org/insights/newsroom');
    expect(blocked?.unlocked).toBe(false);
    expect(blocked?.unlock_error).toContain('blocked');
  });

  it('returns ok with no items when SERP has no organic results', async () => {
    const env = await collect(COMPANY, deps({
      [serpKey(newsQuery(COMPANY))]: 'news/serp-empty.json',
    }));
    expect(env.ok).toBe(true);
    expect(env.items).toEqual([]);
    expect(env.credits_spent).toBe(1);
  });

  it('fails honestly when the SERP zone returns the unsupported-target body', async () => {
    const env = await collect(COMPANY, deps({
      [serpKey(newsQuery(COMPANY))]: 'news/serp-unsupported.txt',
    }));
    expect(env.ok).toBe(false);
    expect(env.error).toContain('isn\'t supported');
    expect(env.items).toEqual([]);
    expect(env.raw_excerpt).toBe('');
  });
});
