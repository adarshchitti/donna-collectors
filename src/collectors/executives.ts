import { failed, type Collector, type CanonicalCompany, type Item } from '../contract.js';
import { assertUnblocked, clip, envelope, headlineNorm, parseSerp, slug, textAt } from '../util.js';
import { hostname } from '../url.js';

/**
 * executives — appointment/departure moves, via SERP + the top press release.
 *
 * Query: `"<name>" appoints OR names OR joins OR departs CEO OR CFO OR
 * president`. Moves are extracted from the exact SERP title/description text
 * (which is also what lands in raw_excerpt), and the top matching link is
 * unlocked for the press-release body.
 *
 * key = move:<person-slug>:<role-slug>:<date> — the record is "person holds
 * role as of date". Date is normalized to yyyy-mm-dd; 'undated' when the
 * SERP carries no date so the key stays stable across runs.
 */
const ROLE =
  '(chief\\s+[a-z]+\\s+officer|CEO|CFO|COO|CTO|CIO|CMO|president|vice\\s+president|general\\s+counsel|treasurer|controller)';
const PERSON = "([A-Z][\\w.'-]+(?:\\s+[A-Z][\\w.'-]+){1,3})";

const PATTERNS: { kind: 'departure' | 'appointment'; re: RegExp; personIdx: number; roleIdx: number }[] = [
  { kind: 'departure', re: new RegExp(`departure of\\s+${ROLE}[,\\s]+${PERSON}`, 'i'), personIdx: 2, roleIdx: 1 },
  { kind: 'departure', re: new RegExp(`${PERSON}\\s+(?:will\\s+)?(?:departs?|resigns?|steps\\s+down)(?:\\s+as)?\\s*${ROLE}?`, 'i'), personIdx: 1, roleIdx: 2 },
  { kind: 'appointment', re: new RegExp(`names?\\s+${PERSON}\\s+(?:as\\s+|its\\s+|new\\s+)*${ROLE}`, 'i'), personIdx: 1, roleIdx: 2 },
  { kind: 'appointment', re: new RegExp(`${PERSON}\\s+joins\\s+[\\w\\s.,-]+?\\s+as\\s+${ROLE}`, 'i'), personIdx: 1, roleIdx: 2 },
  { kind: 'appointment', re: new RegExp(`appointment of\\s+${PERSON}\\s+as\\s+${ROLE}`, 'i'), personIdx: 1, roleIdx: 2 },
  { kind: 'appointment', re: new RegExp(`${PERSON}\\s+(?:named|appointed)\\s+(?:as\\s+|its\\s+|new\\s+)*${ROLE}`, 'i'), personIdx: 1, roleIdx: 2 },
];

export function execQuery(company: CanonicalCompany): string {
  return `"${company.canonical_name}" appoints OR names OR joins OR departs CEO OR CFO OR president`;
}

function normDate(raw?: string): string {
  if (!raw) return 'undated';
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 'undated' : new Date(t).toISOString().slice(0, 10);
}

export const collect: Collector = async (company, deps) => {
  const query = execQuery(company);
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=us&hl=en`;
  let credits = 0;
  try {
    const res = await deps.fetcher.serp(query);
    credits += res.credits_spent;
    const results = parseSerp(res.body);

    const items: Item[] = [];
    const excerpts: string[] = [];
    const seen = new Set<string>();
    let unlocked = false;

    for (const r of results) {
      // match the title first — person/role names bleed into the description
      let move: { person: string; role: string; kind: string } | undefined;
      for (const text of [r.title, `${r.title} ${r.description}`]) {
        for (const p of PATTERNS) {
          const m = p.re.exec(text);
          if (m) {
            move = { person: m[p.personIdx]!.trim(), role: m[p.roleIdx]!.trim(), kind: p.kind };
            break;
          }
        }
        if (move) break;
      }
      if (!move) continue;

      const date = normDate(r.date);
      const key = `move:${slug(move.person)}:${slug(move.role)}:${date}`;
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        key,
        type: 'executive_move',
        person: move.person,
        role: move.role,
        kind: move.kind,
        date,
        title: r.title,
        headline_norm: headlineNorm(r.title),
        url: r.link,
        outlet: hostname(r.link),
      });
      excerpts.push(`=== ${r.link}\n${r.title}\n${r.description}`.trim());

      if (!unlocked) {
        unlocked = true;
        try {
          const pr = await deps.fetcher.unlocker(r.link);
          credits += pr.credits_spent;
          assertUnblocked(pr.body);
          const body = textAt(pr.body, 'article') || textAt(pr.body, 'main') || textAt(pr.body, 'p');
          if (body) excerpts.push(`--- press release body\n${clip(body, 1500)}`);
        } catch {
          // press release unreachable — the SERP row is still the record
        }
      }
    }

    return envelope(company, 'executives', deps, {
      items,
      raw_excerpt: clip(excerpts.join('\n')),
      source_url: searchUrl,
      credits_spent: credits,
    });
  } catch (e) {
    return failed(company, 'executives', deps, e, searchUrl, credits);
  }
};

