import { load } from 'cheerio';
import { failed, type Collector, type CanonicalCompany, type Item } from '../contract.js';
import { assertUnblocked, clip, envelope, slug, textAt } from '../util.js';

/**
 * registry — OpenCorporates, Ohio jurisdiction (us_oh).
 *
 * REPLACES Ohio SoS: businesssearch.ohiosos.gov is classified as Government
 * and Bright Data refuses to fetch it by policy (x-brd-error on HTTP 200).
 * OpenCorporates republishes the same Ohio SoS registry feed — status,
 * registered address, previous names, filing history — on a non-government
 * domain that Bright Data serves.
 *
 * Flow (two unlocks):
 *   1. https://opencorporates.com/companies/us_oh?q=<canonical name>
 *      -> pick the best-matching <li.search-result.company>
 *   2. https://opencorporates.com/companies/us_oh/<company number>
 *      -> dl.attributes (status, address, previous names, officers) and
 *         div#filings (OC filing id, type, date)
 *
 * KNOWN GAPS (vs the SoS page we used to target):
 *   - Officers are login-gated on OpenCorporates ("N officers available,
 *     please log in") — emit officer items only when the list is public.
 *   - No statutory agent name and no filing PDFs.
 *   Filings that name a transfer of control (MERGER/CONSOLIDATION/…) are
 *   emitted as type 'change_of_control' (tier-1 signal), not plain filings.
 *
 * Search-result rows look like:
 *   <li class='search-result company inactive dead'>
 *     <span class='status label'>inactive</span>
 *     <a class='company_search_result' href='/companies/us_oh/1215332'>NAME</a>
 *     <span class='address'>FRANKLIN, COLUMBUS</span>
 *     <span class='slight_highlight'>Previously/Alternatively known as X</span>
 */
const OC = 'https://opencorporates.com';
const JURIS = 'us_oh';

export function searchUrl(company: CanonicalCompany): string {
  return `${OC}/companies/${JURIS}?q=${encodeURIComponent(company.canonical_name)}`;
}
export function companyUrl(ocId: string): string {
  return `${OC}/companies/${JURIS}/${encodeURIComponent(ocId)}`;
}

/** Normalize for matching: punctuation out, legal suffixes canonicalized. */
function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\bincorporated\b/g, 'inc')
    .replace(/\bcorporation\b/g, 'corp')
    .replace(/\blimited\b/g, 'ltd')
    .replace(/\s+/g, ' ')
    .trim();
}
/** Same, minus all legal-suffix tokens — the "core" trading name. */
function coreName(s: string): string {
  return normName(s)
    .replace(/\b(inc|corp|co|ltd|llc|lp|llp|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Candidate {
  ocId: string;
  name: string;
  score: number;
}

/** Score a search-result <li> against the canonical company. */
function scoreCandidate(
  name: string,
  priorHints: string[],
  wanted: string[],
): number {
  const exact = normName(name);
  const core = coreName(name);
  let score = 0;
  for (const w of wanted) {
    if (exact === normName(w)) return 3;
    if (core && core === coreName(w)) score = Math.max(score, 2);
    else if (priorHints.some((h) => normName(h) === normName(w) || coreName(h) === coreName(w)))
      score = Math.max(score, 2);
    else if (core && w && (core.startsWith(coreName(w)) || coreName(w).startsWith(core)))
      score = Math.max(score, 1);
  }
  return score;
}

const CONTROL_TRANSFER = /merger|consolidat|acqui|takeover|demerger/i;

export const collect: Collector = async (company, deps) => {
  const sUrl = searchUrl(company);
  let credits = 0;
  try {
    const search = await deps.fetcher.unlocker(sUrl);
    credits += search.credits_spent;
    assertUnblocked(search.body);
    const $s = load(search.body);

    const wanted = [company.canonical_name, ...company.aliases];
    let best: Candidate | undefined;
    $s('li.search-result.company').each((_i, el) => {
      const a = $s(el).find('a.company_search_result').first();
      const ocId = /\/companies\/[a-z_]+\/(\w+)/.exec(a.attr('href') ?? '')?.[1];
      const name = a.text().replace(/\s+/g, ' ').trim();
      if (!ocId || !name) return;
      const priorHints = $s(el)
        .find('span.slight_highlight')
        .map((_j, h) =>
          /previously\/alternatively known as\s+(.+)$/i.exec($s(h).text().trim())?.[1] ?? '',
        )
        .get()
        .filter(Boolean);
      const score = scoreCandidate(name, priorHints, wanted);
      if (score > 0 && (!best || score > best.score)) best = { ocId, name, score };
    });

    if (!best) {
      return envelope(company, 'registry', deps, {
        items: [],
        raw_excerpt: clip(textAt(search.body, '#results')),
        source_url: sUrl,
        credits_spent: credits,
      });
    }
    const matched = best as Candidate;
    const cUrl = companyUrl(matched.ocId);

    const page = await deps.fetcher.unlocker(cUrl);
    credits += page.credits_spent;
    assertUnblocked(page.body);
    const $ = load(page.body);

    const items: Item[] = [];
    const excerptParts: string[] = [];

    const entityNo = $('dd.company_number').first().text().replace(/\s+/g, ' ').trim();
    if (entityNo) {
      items.push({ key: 'meta:entity_number', type: 'meta', field: 'entity_number', value: entityNo });
    }
    $('dd.other_identifiers a.identifier').each((_i, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      const m = /^(.+?):\s*(\S.*)$/.exec(t);
      if (!m) return;
      items.push({
        key: `identifier:${slug(m[1]!)}`,
        type: 'meta',
        field: 'identifier',
        scheme: m[1],
        value: m[2],
      });
    });

    const status = $('dd.status').first().text().replace(/\s+/g, ' ').trim();
    if (status) {
      items.push({ key: 'status:current', type: 'status', status, value: status });
      excerptParts.push(`Status: ${status}`);
    }

    const addr = $('dd.registered_address li.address_line')
      .map((_i, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean)
      .join(', ');
    if (addr) {
      items.push({ key: 'address:registered', type: 'address', address: addr, value: addr });
      excerptParts.push(`Registered address: ${addr}`);
    }

    $('dd.previous_names li.name_line').each((_i, el) => {
      const name = $(el).text().replace(/\s+/g, ' ').trim();
      if (!name) return;
      items.push({ key: `prior_name:${slug(name)}`, type: 'prior_name', name, value: name });
      excerptParts.push(`Previously known as ${name}`);
    });

    // Officers are login-gated on OC for some companies — emit only when the
    // list is actually public (a "please log in" link is not an officer).
    const officersDd = $('dd.officers');
    if (!/log in/i.test(officersDd.text())) {
      officersDd.find('li').each((_i, el) => {
        const t = $(el).text().replace(/\s+/g, ' ').trim();
        if (!t) return;
        const m = /^(.+?),\s*(.+)$/.exec(t);
        const name = (m?.[1] ?? t).trim();
        const role = (m?.[2] ?? 'officer').trim();
        items.push({ key: `officer:${slug(name)}:${slug(role)}`, type: 'officer', name, role });
        excerptParts.push(`${name}, ${role}`);
      });
    }

    $('#filings .filing').each((_i, el) => {
      const filingId = /filing_(\d+)/.exec($(el).attr('id') ?? '')?.[1];
      const filingType = $(el).find('.subhead a.filing').text().replace(/\s+/g, ' ').trim();
      const date = $(el).find('.dateline').text().replace(/\s+/g, ' ').trim();
      const description = $(el).find('.description').text().replace(/\s+/g, ' ').trim();
      if (!filingId || !filingType) return;
      if (CONTROL_TRANSFER.test(filingType)) {
        items.push({
          key: `change_of_control:${filingId}`,
          type: 'change_of_control',
          filing_id: filingId,
          filing_type: filingType,
          date,
          description,
          evidence: `OpenCorporates us_oh filing ${filingId}`,
        });
      } else {
        items.push({
          key: `filing:${filingId}`,
          type: 'filing',
          filing_id: filingId,
          filing_type: filingType,
          date,
        });
      }
      excerptParts.push(`${date} ${filingType}`);
    });

    const raw = clip([textAt(page.body, 'dl.attributes'), ...excerptParts].filter(Boolean).join(' | '));
    return envelope(company, 'registry', deps, {
      items,
      raw_excerpt: raw,
      source_url: cUrl,
      credits_spent: credits,
    });
  } catch (e) {
    return failed(company, 'registry', deps, e, sUrl, credits);
  }
};
