import { load } from 'cheerio';
import { failed, type Collector, type CanonicalCompany, type Item } from '../contract.js';
import { assertUnblocked, clip, envelope, sha1 } from '../util.js';

/**
 * domain — WHOIS record + homepage fingerprint (inferred trust).
 *
 * Two unlocks: https://www.whois.com/whois/<domain> (parsed from the raw
 * "Label: value" text block) and https://<domain>/ (title + sha1 of the
 * full body as content_hash — the differ flags any byte-level change).
 *
 * keys: whois:<field>, home:hash, home:title. A `whois:` key names the FIELD
 * (registrar, registered, expires, updated, name_servers), never the value —
 * a registrar change must read as one altered record, not remove+add.
 */
export function whoisUrl(domain: string): string {
  return `https://www.whois.com/whois/${encodeURIComponent(domain)}`;
}
export function homeUrl(domain: string): string {
  return `https://${domain}/`;
}

const WHOIS_FIELDS: [string, RegExp][] = [
  ['registrar', /^Registrar:\s*(.+)$/im],
  ['registered', /^(?:Creation Date|Registered On):\s*(.+)$/im],
  ['expires', /^(?:Registry Expiry Date|Registrar Registration Expiration Date|Expiry Date):\s*(.+)$/im],
  ['updated', /^Updated Date:\s*(.+)$/im],
];

export const collect: Collector = async (company, deps) => {
  const domain = company.domains[0];
  if (!domain) return failed(company, 'domain', deps, 'canonical company has no domain');
  const wUrl = whoisUrl(domain);
  const hUrl = homeUrl(domain);
  let credits = 0;
  try {
    const items: Item[] = [];
    const excerpts: string[] = [];

    const whois = await deps.fetcher.unlocker(wUrl);
    credits += whois.credits_spent;
    assertUnblocked(whois.body);
    const $w = load(whois.body);
    const raw = $w('.whois-raw, .df-value, pre').first().text();
    excerpts.push(raw.replace(/\s+/g, ' ').trim());

    for (const [field, re] of WHOIS_FIELDS) {
      const m = re.exec(raw);
      if (m) items.push({ key: `whois:${field}`, type: 'whois_field', field, value: m[1]!.trim() });
    }
    const servers = [...raw.matchAll(/^Name Server:\s*(.+)$/gim)].map((m) => m[1]!.trim()).sort();
    if (servers.length) {
      items.push({ key: 'whois:name_servers', type: 'whois_field', field: 'name_servers', value: servers.join(', ') });
    }

    const home = await deps.fetcher.unlocker(hUrl);
    credits += home.credits_spent;
    assertUnblocked(home.body);
    const $h = load(home.body);
    const title = $h('title').first().text().replace(/\s+/g, ' ').trim();
    items.push({ key: 'home:hash', type: 'page_hash', content_hash: sha1(home.body) });
    if (title) items.push({ key: 'home:title', type: 'page_title', title, value: title });

    return envelope(company, 'domain', deps, {
      items,
      raw_excerpt: clip(excerpts.filter(Boolean).join('\n')),
      source_url: wUrl,
      credits_spent: credits,
    });
  } catch (e) {
    return failed(company, 'domain', deps, e, wUrl, credits);
  }
};
