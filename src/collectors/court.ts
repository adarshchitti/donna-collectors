import { load } from 'cheerio';
import { failed, type Collector, type CanonicalCompany, type Item } from '../contract.js';
import { assertUnblocked, clip, envelope, textAt } from '../util.js';

/**
 * court — Franklin County Common Pleas, Case Information Online.
 *
 * URL pattern: party-name search at
 *   https://fcdcfcjs.co.franklin.oh.us/CaseInformationOnline/partySearch?name=<name>
 *
 * KNOWN LIMITATION (from the portal itself): the online docket lags real
 * filings by 2–5 business days. The page states a "current through" date;
 * we surface it as item `meta:current_through` so downstream can honestly
 * say "court records current to <date>" instead of implying the docket is
 * live.
 *
 * Selectors (see fixtures/court/party-search-healthy.html):
 *   .current-through              — portal's own data-currency date
 *   .party-results tbody tr       — one row per case
 *   a.case-link[href*=caseNumber] — docket number, compact form in the URL
 */
export function partySearchUrl(company: CanonicalCompany): string {
  return (
    'https://fcdcfcjs.co.franklin.oh.us/CaseInformationOnline/partySearch?name=' +
    encodeURIComponent(company.canonical_name)
  );
}

export const collect: Collector = async (company, deps) => {
  const url = partySearchUrl(company);
  let credits = 0;
  try {
    const res = await deps.fetcher.unlocker(url);
    credits += res.credits_spent;
    assertUnblocked(res.body);
    const $ = load(res.body);

    const items: Item[] = [];
    const excerptParts: string[] = [];

    const currentThrough = $('.current-through').first().text().replace(/\s+/g, ' ').trim();
    if (currentThrough) {
      items.push({
        key: 'meta:current_through',
        type: 'meta',
        field: 'current_through',
        value: currentThrough,
      });
      excerptParts.push(`Case information is current through ${currentThrough}`);
    }

    $('.party-results tbody tr').each((_i, el) => {
      const href = $(el).find('a.case-link').attr('href') ?? '';
      const m = /caseNumber=([A-Za-z0-9]+)/.exec(href);
      const docket = m?.[1] ?? $(el).find('a.case-link').text().replace(/\s+/g, '').trim();
      if (!docket) return;
      const item: Item = {
        key: `case:${docket}`,
        type: 'case',
        docket_number: docket,
        caption: $(el).find('.caption').text().replace(/\s+/g, ' ').trim(),
        role: $(el).find('.role').text().replace(/\s+/g, ' ').trim(),
        filed: $(el).find('.filed').text().replace(/\s+/g, ' ').trim(),
        status: $(el).find('.status').text().replace(/\s+/g, ' ').trim(),
      };
      items.push(item);
      excerptParts.push(`${docket} — ${item.caption} (${item.role}, filed ${item.filed}, ${item.status})`);
    });

    const countText = textAt(res.body, '.count');
    if (items.length === 0 && countText) excerptParts.push(countText);

    return envelope(company, 'court', deps, {
      items,
      raw_excerpt: clip(excerptParts.join('\n')),
      source_url: url,
      credits_spent: credits,
    });
  } catch (e) {
    return failed(company, 'court', deps, e, url, credits);
  }
};
