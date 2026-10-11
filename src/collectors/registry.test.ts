import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CanonicalCompany, type CollectorDeps } from '../contract.js';
import { ReplayFetcher, unlockerKey } from '../fetcher/replay.js';
import { collect, companyUrl, searchUrl } from './registry.js';

// Real Big Lots, Inc. — its OpenCorporates us_oh entity is the renamed
// FORMER BL STORES, INC. (OC id 1215332), matched through the search row's
// "Previously/Alternatively known as BIG LOTS INCORPORATED" hint.
export const COMPANY: CanonicalCompany = {
  company_id: '7b040439-0ed6-4a4e-b3ae-6ab1161b4e98',
  canonical_name: 'Big Lots, Inc.',
  jurisdiction: 'OH',
  registry_id: '1215332',
  aliases: ['BIG LOTS', 'Big Lots Stores'],
  domains: ['biglots.com'],
};

export const DEPS: CollectorDeps = {
  fetcher: new ReplayFetcher({}, 'fixtures'),
  now: () => '2026-10-10T19:42:11Z',
  runId: 'run-biglots-registry',
};

function deps(map: Record<string, string>): CollectorDeps {
  return { ...DEPS, fetcher: new ReplayFetcher(map, 'fixtures') };
}

const SEARCH = { [unlockerKey(searchUrl(COMPANY))]: 'registry/opencorporates-search-biglots.html' };
const BOTH = {
  ...SEARCH,
  [unlockerKey(companyUrl('1215332'))]: 'registry/opencorporates-company-biglots.html',
};

describe('registry collector (OpenCorporates us_oh)', () => {
  it('finds the company through a previous-name hint and parses the company page', async () => {
    const env = await collect(COMPANY, deps(BOTH));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);
    expect(env.source).toBe('registry');
    expect(env.source_url).toBe(companyUrl('1215332'));
    expect(env.credits_spent).toBe(2); // search + company page

    expect(env.items.find((i) => i.key === 'status:current')?.value).toBe('Held');
    expect(env.items.find((i) => i.key === 'meta:entity_number')?.value).toBe('1215332');
    expect(env.items.find((i) => i.key === 'identifier:sec-cik-number')?.value).toBe('768835');
    expect(env.items.find((i) => i.key === 'address:registered')?.value).toContain('FRANKLIN, COLUMBUS');
    expect(env.items.find((i) => i.key === 'prior_name:big-lots-inc')).toBeTruthy();

    // real OC filings: ordinary filings are `filing`, control transfers are `change_of_control`
    expect(env.items.filter((i) => i.type === 'filing').map((i) => i.key).sort()).toEqual([
      'filing:1105435476',
      'filing:1307355719',
      'filing:1469379581',
      'filing:1494962918',
      'filing:1499061802',
      'filing:1503533354',
    ]);
    const coc = env.items.filter((i) => i.type === 'change_of_control');
    expect(coc.map((i) => i.key).sort()).toEqual([
      'change_of_control:1070452113',
      'change_of_control:1070452116',
    ]);
    expect(coc[0]).toMatchObject({ filing_type: 'MERGER/DOMESTIC', date: '29 Jan 2022' });

    // officers are login-gated on this real page — honestly absent
    expect(env.items.filter((i) => i.type === 'officer')).toEqual([]);
    expect(env.raw_excerpt).toContain('Held');
  });

  it('emits officer items when the officers list is public', async () => {
    const env = await collect(COMPANY, deps({
      ...SEARCH,
      [unlockerKey(companyUrl('1215332'))]: 'registry/opencorporates-company-officers.html',
    }));
    expect(env.ok).toBe(true);
    expect(env.items.find((i) => i.key === 'officer:jane-doe:chief-financial-officer'))
      .toMatchObject({ type: 'officer', name: 'JANE DOE' });
    expect(env.items.find((i) => i.key === 'officer:john-smith:president')).toBeTruthy();
    // MERGER/FOREIGN is a control transfer, not an ordinary filing
    expect(env.items.find((i) => i.key === 'change_of_control:1499061802'))
      .toMatchObject({ filing_type: 'MERGER/FOREIGN' });
    expect(env.items.find((i) => i.key === 'filing:1503533354'))
      .toMatchObject({ filing_type: 'DOMESTIC/ANNUAL REPORT' });
  });

  it('returns ok with no items when no search result matches', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(searchUrl(COMPANY))]: 'registry/opencorporates-search-empty.html',
    }));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(true);
    expect(env.items).toEqual([]);
    expect(env.error).toBeNull();
    expect(env.credits_spent).toBe(1); // only the search ran
  });

  it('fails honestly on a blocked page and never throws', async () => {
    const env = await collect(COMPANY, deps({
      [unlockerKey(searchUrl(COMPANY))]: '_shared/blocked.html',
    }));
    expect(() => collectorEnvelopeSchema.parse(env)).not.toThrow();
    expect(env.ok).toBe(false);
    expect(env.error).toBeTruthy();
    expect(env.items).toEqual([]);
    expect(env.raw_excerpt).toBe('');
  });

  it('fails honestly when the fetch itself errors', async () => {
    const env = await collect(COMPANY, deps({}));
    expect(env.ok).toBe(false);
    expect(env.error).toContain('no fixture');
  });
});
