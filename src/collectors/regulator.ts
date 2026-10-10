import { load } from 'cheerio';
import { failed, type Collector, type CanonicalCompany, type Item } from '../contract.js';
import { assertUnblocked, clip, envelope, slug, textAt } from '../util.js';

/**
 * regulator — Ohio eLicense verification + OFAC SDN list search. Two unlocks.
 *
 * URLs:
 *   https://elicense.ohio.gov/OH_VerifyLicense?searchType=entity&name=<name>
 *   https://sanctionssearch.ofac.treas.gov/Search.aspx?name=<name>
 *
 * If either sub-fetch fails the envelope fails — an "ok" snapshot that
 * silently skipped OFAC would read as "no sanctions", which is exactly the
 * false-negative this system exists to prevent.
 *
 * Keys: licence:<license no.>, action:<action id>, sanctions:<list>:<name-slug>
 * A sanctions key names the MATCHED party, not our company — two runs that
 * return the same fuzzy match produce the same key.
 */
export function elicenseUrl(company: CanonicalCompany): string {
  return (
    'https://elicense.ohio.gov/OH_VerifyLicense?searchType=entity&name=' +
    encodeURIComponent(company.canonical_name)
  );
}
export function ofacUrl(company: CanonicalCompany): string {
  return (
    'https://sanctionssearch.ofac.treas.gov/Search.aspx?name=' +
    encodeURIComponent(company.canonical_name)
  );
}

export const collect: Collector = async (company, deps) => {
  const elUrl = elicenseUrl(company);
  const ofacU = ofacUrl(company);
  let credits = 0;
  try {
    const items: Item[] = [];
    const excerpts: string[] = [];

    // --- Ohio eLicense ---
    const lic = await deps.fetcher.unlocker(elUrl);
    credits += lic.credits_spent;
    assertUnblocked(lic.body);
    const $l = load(lic.body);

    $l('.license-results tbody tr').each((_i, el) => {
      const id = $l(el).find('.lic-no').text().trim();
      if (!id) return;
      const status = $l(el).find('.lic-status').text().replace(/\s+/g, ' ').trim();
      items.push({
        key: `licence:${id}`,
        type: 'licence',
        id,
        licence_type: $l(el).find('.lic-type').text().replace(/\s+/g, ' ').trim(),
        board: $l(el).find('.lic-board').text().replace(/\s+/g, ' ').trim(),
        status,
        value: status,
        issued: $l(el).find('.lic-issued').text().replace(/\s+/g, ' ').trim(),
        expires: $l(el).find('.lic-expires').text().replace(/\s+/g, ' ').trim(),
      });
    });
    $l('.actions-table tbody tr').each((_i, el) => {
      const id = $l(el).find('.act-id').text().trim();
      if (!id) return;
      items.push({
        key: `action:${id}`,
        type: 'enforcement_action',
        id,
        date: $l(el).find('.act-date').text().replace(/\s+/g, ' ').trim(),
        action_type: $l(el).find('.act-type').text().replace(/\s+/g, ' ').trim(),
        summary: $l(el).find('.act-summary').text().replace(/\s+/g, ' ').trim(),
      });
    });
    excerpts.push(textAt(lic.body, '.license-results tbody, .no-results'));
    excerpts.push(textAt(lic.body, '.actions-table tbody'));

    // --- OFAC SDN ---
    const sdn = await deps.fetcher.unlocker(ofacU);
    credits += sdn.credits_spent;
    assertUnblocked(sdn.body);
    const $s = load(sdn.body);

    $s('.sdn-table tbody tr').each((_i, el) => {
      const name = $s(el).find('.sdn-name').text().replace(/\s+/g, ' ').trim();
      const list = $s(el).find('.sdn-list').text().trim() || 'SDN';
      if (!name) return;
      items.push({
        key: `sanctions:${slug(list)}:${slug(name)}`,
        type: 'sanctions_match',
        list,
        match: name,
        program: $s(el).find('.sdn-program').text().replace(/\s+/g, ' ').trim(),
        score: $s(el).find('.sdn-score').text().trim(),
      });
    });
    excerpts.push(textAt(sdn.body, '.result-count, .sdn-table tbody'));

    return envelope(company, 'regulator', deps, {
      items,
      raw_excerpt: clip(excerpts.filter(Boolean).join('\n')),
      source_url: elUrl,
      credits_spent: credits,
    });
  } catch (e) {
    return failed(company, 'regulator', deps, e, elUrl, credits);
  }
};
