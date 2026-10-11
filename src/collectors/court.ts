import { failed, type Collector, type CanonicalCompany, type Item } from '../contract.js';
import { clip, envelope, nameMatches, slug } from '../util.js';

/**
 * court — CourtListener (courtlistener.com) federal docket search, REST API.
 *
 * REPLACES Franklin County Common Pleas: fcdcfcjs.co.franklin.oh.us is
 * classified as Government and Bright Data refuses to fetch it by policy
 * (x-brd-error on HTTP 200). CourtListener is the non-government upgrade —
 * its RECAP corpus covers federal civil dockets AND federal BANKRUPTCY
 * dockets, which no previous source could observe at all.
 *
 *   GET https://www.courtlistener.com/api/rest/v4/search/?q="<name>"&type=r
 *   -> {count, results: [{docketNumber, caseName, court, court_id,
 *       jurisdictionType, chapter, cause, suitNature, dateFiled,
 *       dateTerminated, party[], trustee_str, docket_absolute_url, ...}]}
 *
 * Classification:
 *   - Bankruptcy signal (jurisdictionType "Bankruptcy", chapter set, court
 *     name contains "bankruptcy", a "-bk-" docket, or a bankruptcy cause)
 *     -> type 'insolvency_filing' — a distinct tier-1 item, never flattened
 *     into an ordinary case. The docket type/nature-of-suit ride along so
 *     downstream can classify further.
 *   - Anything else -> type 'case' with a `status` field: 'stayed' when the
 *     record's own text reports a stay (e.g. an automatic-stay suggestion),
 *     'terminated <date>' when dateTerminated is set, else 'open'.
 *
 * Results are full-text hits; only rows where the company (or an alias) is
 * actually a PARTY or appears in the caption become items — the rest are
 * mentions and would read as docket activity that is not ours.
 *
 * Known limits: the API returns the first results page only (one fetch per
 * run, per the budget rule); county/state courts are out of CourtListener's
 * scope — a real coverage gap, recorded in NOTES.md.
 */
const CL = 'https://www.courtlistener.com';

export function searchUrl(company: CanonicalCompany): string {
  return `${CL}/api/rest/v4/search/?q=${encodeURIComponent(`"${company.canonical_name}"`)}&type=r`;
}

interface ClResult {
  docketNumber?: string;
  caseName?: string;
  court?: string;
  court_id?: string;
  jurisdictionType?: string;
  chapter?: string;
  cause?: string;
  suitNature?: string;
  dateFiled?: string;
  dateTerminated?: string | null;
  party?: string[];
  trustee_str?: string;
  docket_absolute_url?: string;
  status?: string | null;
}

/**
 * A docket that IS a bankruptcy proceeding — chapter set, bankruptcy court /
 * jurisdiction type, a "-bk-" docket number, or a bankruptcy-petition cause.
 * A civil case that merely REPORTS a stay (e.g. "11 U.S.C. §362 Suggestion of
 * Bankruptcy") is a `case` with status 'stayed', not an insolvency filing.
 */
const BK_PETITION = /bankruptcy\s+petition|chapter\s*(?:7|9|11|12|13|15)\b/i;

function isBankruptcy(r: ClResult): boolean {
  if (r.chapter && r.chapter.trim()) return true;
  if (/bankrupt/i.test(`${r.jurisdictionType ?? ''} ${r.court ?? ''}`)) return true;
  if (/\d+-bk-/i.test(r.docketNumber ?? '')) return true;
  return BK_PETITION.test(`${r.cause ?? ''} ${r.suitNature ?? ''}`);
}

function caseStatus(r: ClResult): string {
  const text = `${r.caseName ?? ''} ${r.cause ?? ''} ${r.suitNature ?? ''} ${r.status ?? ''}`;
  if (/\bstay(?:ed)?\b/i.test(text)) {
    return r.dateTerminated ? `stayed; terminated ${r.dateTerminated}` : 'stayed';
  }
  return r.dateTerminated ? `terminated ${r.dateTerminated}` : 'open';
}

export const collect: Collector = async (company, deps) => {
  const url = searchUrl(company);
  let credits = 0;
  try {
    const res = await deps.fetcher.unlocker(url);
    credits += res.credits_spent;

    let data: { count?: number; results?: ClResult[] };
    try {
      data = JSON.parse(res.body) as { count?: number; results?: ClResult[] };
    } catch {
      throw new Error('CourtListener response was not JSON');
    }
    const results = data.results ?? [];

    const items: Item[] = [];
    const excerpts: string[] = [];

    if (typeof data.count === 'number') {
      items.push({
        key: 'meta:result_count',
        type: 'meta',
        field: 'result_count',
        value: String(data.count),
      });
    }

    for (const r of results) {
      const docket = r.docketNumber?.trim();
      if (!docket) continue;
      // keep only rows where the company is a party / in the caption —
      // type=r is full-text and most hits merely mention the name
      const hay = `${r.caseName ?? ''} ${(r.party ?? []).join(' ')}`;
      if (!nameMatches(company, hay)) continue;

      const base = {
        docket_number: docket,
        case_name: (r.caseName ?? '').replace(/\s+/g, ' ').trim(),
        court: r.court ?? '',
        court_id: r.court_id ?? '',
        docket_type: r.jurisdictionType ?? '',
        suit_nature: r.suitNature ?? '',
        cause: r.cause ?? '',
        filed: r.dateFiled ?? '',
        status: caseStatus(r),
        party: r.party ?? [],
        docket_url: r.docket_absolute_url ? `${CL}${r.docket_absolute_url}` : '',
      };
      const keyId = `${base.court_id || slug(base.court) || 'unknown'}:${docket}`;

      if (isBankruptcy(r)) {
        items.push({
          key: `insolvency:${keyId}`,
          type: 'insolvency_filing',
          ...base,
          chapter: r.chapter ?? '',
          trustee: r.trustee_str ?? '',
        });
        excerpts.push(
          `${docket} — ${base.case_name} (${base.court}, filed ${base.filed}, chapter ${r.chapter ?? '?'}, ${base.status})`,
        );
      } else {
        items.push({ key: `case:${keyId}`, type: 'case', ...base });
        excerpts.push(
          `${docket} — ${base.case_name} (${base.court}, filed ${base.filed}, ${base.status})`,
        );
      }
    }

    if (items.length <= (typeof data.count === 'number' ? 1 : 0) && results.length > 0) {
      excerpts.push(`${results.length} search hits on this page; none named the company as a party.`);
    }

    return envelope(company, 'court', deps, {
      items,
      raw_excerpt: clip(excerpts.join('\n')),
      source_url: url,
      credits_spent: credits,
    });
  } catch (e) {
    return failed(company, 'court', deps, e, url, credits);
  }
};
