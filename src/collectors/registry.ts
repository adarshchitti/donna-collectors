import { load } from 'cheerio';
import { failed, type Collector, type CanonicalCompany, type Item } from '../contract.js';
import { assertUnblocked, clip, envelope, slug, textAt } from '../util.js';

/**
 * registry — Ohio Secretary of State business details.
 *
 * URL pattern: https://businesssearch.ohiosos.gov/?businessDetails/<entity #>
 * (the SPA renders the details pane for that entity; the Unlocker returns the
 * rendered page). registry_id on the canonical company is the entity number.
 *
 * Selectors (see fixtures/registry/details-healthy.html):
 *   .entity-info dt/dd pairs  — Status, Entity Number, filing type, dates
 *   .statutory-agent          — agent name + registered address
 *   .principals-table tr      — officers/principals
 *   .filings-table a.f-doc    — href="?filingDetails/<filing_id>"
 *   .prior-names-list li      — prior names
 */
export function detailsUrl(company: CanonicalCompany): string {
  return `https://businesssearch.ohiosos.gov/?businessDetails/${encodeURIComponent(company.registry_id)}`;
}

export const collect: Collector = async (company, deps) => {
  const url = detailsUrl(company);
  let credits = 0;
  try {
    const res = await deps.fetcher.unlocker(url);
    credits += res.credits_spent;
    assertUnblocked(res.body);
    const $ = load(res.body);

    if ($('.no-results').length > 0 || $('.entity-info').length === 0) {
      const excerpt = clip(textAt(res.body, '.no-results, .business-details'));
      return envelope(company, 'registry', deps, {
        items: [],
        raw_excerpt: excerpt,
        source_url: url,
        credits_spent: credits,
      });
    }

    // dl.entity-info -> {label: value}
    const info: Record<string, string> = {};
    $('.entity-info dt').each((_i, el) => {
      const label = $(el).text().replace(/\s+/g, ' ').trim();
      const dd = $(el).next('dd');
      if (label && dd.length) info[label] = dd.text().replace(/\s+/g, ' ').trim();
    });

    const items: Item[] = [];
    const excerptParts: string[] = [];

    const status = info['Status'];
    if (status) {
      items.push({ key: 'status:current', type: 'status', status, value: status });
      excerptParts.push(`Status: ${status}`);
    }

    const agentName = $('.statutory-agent .agent-name').first().text().replace(/\s+/g, ' ').trim();
    const agentAddr = $('.statutory-agent .agent-address').first().text().replace(/\s+/g, ' ').trim();
    if (agentAddr) {
      items.push({ key: 'address:registered', type: 'address', address: agentAddr, value: agentAddr, agent: agentName });
      excerptParts.push(`Registered address: ${agentAddr}${agentName ? ` (agent ${agentName})` : ''}`);
    }

    $('.principals-table tbody tr').each((_i, el) => {
      const name = $(el).find('.p-name').text().replace(/\s+/g, ' ').trim();
      const role = $(el).find('.p-role').text().replace(/\s+/g, ' ').trim();
      const since = $(el).find('.p-since').text().replace(/\s+/g, ' ').trim();
      if (!name || !role) return;
      const item: Item = {
        key: `officer:${slug(name)}:${slug(role)}`,
        type: 'officer',
        name,
        role,
      };
      if (since) item.since = since;
      items.push(item);
      excerptParts.push(`${name}, ${role}${since ? `, since ${since}` : ''}`);
    });

    $('.filings-table tbody tr').each((_i, el) => {
      const href = $(el).find('a.f-doc').attr('href') ?? '';
      const m = /filingDetails\/(\d+)/.exec(href);
      const filingId = m?.[1];
      const filingType = $(el).find('.f-type').text().replace(/\s+/g, ' ').trim();
      const date = $(el).find('.f-date').text().replace(/\s+/g, ' ').trim();
      if (!filingId) return;
      items.push({ key: `filing:${filingId}`, type: 'filing', filing_id: filingId, filing_type: filingType, date });
    });

    $('.prior-names-list li').each((_i, el) => {
      const name = $(el).clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
      if (!name) return;
      items.push({ key: `prior_name:${slug(name)}`, type: 'prior_name', name, value: name });
    });

    const entityText = textAt(res.body, '.entity-info');
    const raw = clip([entityText, ...excerptParts].filter(Boolean).join(' | '));

    return envelope(company, 'registry', deps, {
      items,
      raw_excerpt: raw,
      source_url: url,
      credits_spent: credits,
    });
  } catch (e) {
    return failed(company, 'registry', deps, e, url, credits);
  }
};
