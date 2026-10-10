import { failed, type Collector, type CanonicalCompany, type Item } from '../contract.js';
import { assertUnblocked, clip, envelope, headlineNorm, parseSerp, sha1, textAt } from '../util.js';
import { hostname } from '../url.js';

/**
 * news — SERP first, then unlock article bodies.
 *
 * Query: `"<canonical name>" news` against google with gl=us&hl=en pinned
 * inside LiveFetcher. SERP zone returns parsed JSON
 * {organic:[{title,link,description,rank,date?}]}.
 *
 * Then the top MAX_ARTICLE_UNLOCKS result URLs go through Web Unlocker for
 * the article body. Every result gets an item (the SERP row is itself an
 * observation); unlocked ones additionally carry `date` and `body`.
 *
 * key = article:<sha1(url)> — the record is the article at that URL.
 * headline_norm is set on every item so the differ collapses syndicated
 * reposts of the same story into one.
 */
export const MAX_ARTICLE_UNLOCKS = 3;

export function newsQuery(company: CanonicalCompany): string {
  return `"${company.canonical_name}" news`;
}

export const collect: Collector = async (company, deps) => {
  const query = newsQuery(company);
  let credits = 0;
  const seen = new Set<string>();
  try {
    const res = await deps.fetcher.serp(query);
    credits += res.credits_spent;
    const results = parseSerp(res.body);

    const items: Item[] = [];
    const excerpts: string[] = [];
    let unlockAttempts = 0; // cap attempts, not successes — each costs a credit

    for (const r of results) {
      const key = `article:${sha1(r.link)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const item: Item = {
        key,
        type: 'article',
        headline: r.title,
        headline_norm: headlineNorm(r.title),
        url: r.link,
        outlet: hostname(r.link),
      };
      if (r.date) item.date = r.date;

      if (unlockAttempts < MAX_ARTICLE_UNLOCKS) {
        unlockAttempts += 1;
        try {
          const art = await deps.fetcher.unlocker(r.link);
          credits += art.credits_spent;
          assertUnblocked(art.body);
          const body = textAt(art.body, 'article') || textAt(art.body, 'main') || '';
          const time =
            textAt(art.body, 'time[datetime]') ||
            textAt(art.body, '.published, .date, .article-date, time');
          const fallback = body || textAt(art.body, 'p');
          if (time && !item.date) item.date = time;
          if (fallback) item.body = clip(fallback, 2000);
          item.unlocked = true;
          excerpts.push(`=== ${r.link}\n${fallback || r.description || r.title}`);
        } catch (e) {
          // One blocked/failed article is an item-level gap, not a source failure.
          item.unlocked = false;
          item.unlock_error = e instanceof Error ? e.message : String(e);
          if (r.description) excerpts.push(`=== ${r.link}\n${r.description}`);
        }
      } else {
        item.unlocked = false;
        if (r.description) excerpts.push(`=== ${r.link}\n${r.description}`);
      }

      items.push(item);
    }

    return envelope(company, 'news', deps, {
      items,
      raw_excerpt: clip(excerpts.join('\n')),
      source_url: `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=us&hl=en`,
      credits_spent: credits,
    });
  } catch (e) {
    return failed(company, 'news', deps, e, `https://www.google.com/search?q=${encodeURIComponent(query)}`, credits);
  }
};
