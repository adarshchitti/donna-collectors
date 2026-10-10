import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher, unlockerKey } from '../fetcher/replay.js';
import { collect, homeUrl, whoisUrl } from './domain.js';

const COMPANY: CanonicalCompany = {
  company_id: '7b040439-0ed6-4a4e-b3ae-6ab1161b4e98',
  canonical_name: 'NORDVALE MATERIALS INC.',
  jurisdiction: 'OH',
  registry_id: '2447113',
  aliases: ['NORDVALE MATERIALS'],
  domains: ['nordvale.example.com'],
};

const DEPS = { now: () => '2026-10-10T19:42:11Z', runId: 'run-nordvale-domain' };
const deps = (map: Record<string, string>): CollectorDeps => ({
  ...DEPS,
  fetcher: new ReplayFetcher(map, 'fixtures'),
});

const DOMAIN = 'nordvale.example.com';

describe('domain collector', () => {
  it('parses whois fields and fingerprints the homepage', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(whoisUrl(DOMAIN))]: 'domain/whois-healthy.html',
      [unlockerKey(homeUrl(DOMAIN))]: 'domain/home-healthy.html',
    }));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);
    expect(env.credits_spent).toBe(2);

    // keys name the FIELD, not the value — a registrar change diffs as altered
    expect(env.items.find((i) => i.key === 'whois:registrar')?.value).toBe('Example Registrar LLC');
    expect(env.items.find((i) => i.key === 'whois:expires')?.value).toContain('2028-04-12');
    expect(env.items.find((i) => i.key === 'whois:name_servers')?.value)
      .toBe('NS1.EXAMPLENAMES.COM, NS2.EXAMPLENAMES.COM');

    const hash = env.items.find((i) => i.key === 'home:hash');
    expect(hash?.content_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(env.items.find((i) => i.key === 'home:title')?.title)
      .toBe('Nordvale Materials — Advanced Materials, Columbus OH');
  });

  it('emits only real observations when whois has no record', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(whoisUrl(DOMAIN))]: 'domain/whois-empty.html',
      [unlockerKey(homeUrl(DOMAIN))]: 'domain/home-parked.html',
    }));
    expect(env.ok).toBe(true);
    expect(env.items.filter((i) => i.key.startsWith('whois:'))).toEqual([]);
    expect(env.items.find((i) => i.key === 'home:title')).toBeUndefined();
    expect(env.items.find((i) => i.key === 'home:hash')).toBeTruthy();
    expect(env.raw_excerpt).toContain('No match for domain');
  });

  it('fails honestly when the whois fetch is blocked', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(whoisUrl(DOMAIN))]: '_shared/blocked.html',
      [unlockerKey(homeUrl(DOMAIN))]: 'domain/home-healthy.html',
    }));
    expect(env.ok).toBe(false);
    expect(env.items).toEqual([]);
    expect(env.raw_excerpt).toBe('');
  });
});
