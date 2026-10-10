import { load } from 'cheerio';
import { failed, type Collector, type CanonicalCompany, type Item } from '../contract.js';
import { assertUnblocked, clip, envelope, parseSerp, slug, textAt } from '../util.js';

/**
 * jobs — open-role count and titles (inferred trust).
 *
 * Flow: SERP `"<name>" careers open positions`, then unlock the first
 * careers-shaped result (jobs.*, /careers, greenhouse/lever/workday/ashby/
 * icims). Job cards are read from `.job-card a.job-title`.
 *
 * If no careers link appears in the SERP at all, we do NOT guess a URL —
 * speculative fetches are banned by the budget rules. Instead we fall back
 * to an inferred count from snippet text like "75 X Jobs in Columbus", and
 * mark the item `basis: 'serp-snippet'` so downstream knows it's weaker.
 */
export function jobsQuery(company: CanonicalCompany): string {
  return `"${company.canonical_name}" careers open positions`;
}

const CAREERSISH = /career|jobs\.|greenhouse|lever\.co|workdayjobs|myworkdayjobs|ashbyhq|icims|bamboohr|jobvite|smartrecruiters/i;

export const collect: Collector = async (company, deps) => {
  const query = jobsQuery(company);
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=us&hl=en`;
  let credits = 0;
  try {
    const res = await deps.fetcher.serp(query);
    credits += res.credits_spent;
    const results = parseSerp(res.body);

    const items: Item[] = [];
    const excerpts: string[] = [];

    const careers = results.find((r) => CAREERSISH.test(r.link));

    if (careers) {
      const page = await deps.fetcher.unlocker(careers.link);
      credits += page.credits_spent;
      assertUnblocked(page.body);
      const $ = load(page.body);

      const titles: string[] = [];
      $('a.job-title, .job-card .job-title').each((_i, el) => {
        const t = $(el).text().replace(/\s+/g, ' ').trim();
        if (t) titles.push(t);
      });
      for (const title of titles) {
        items.push({ key: `jobs:title:${slug(title)}`, type: 'job_title', title });
      }
      items.push({
        key: 'jobs:count',
        type: 'job_count',
        open_roles: titles.length,
        value: String(titles.length),
        basis: 'careers-page',
      });
      excerpts.push(`=== ${careers.link}\n${textAt(page.body, 'main') || textAt(page.body, 'body')}`);
      return envelope(company, 'jobs', deps, {
        items,
        raw_excerpt: clip(excerpts.join('\n')),
        source_url: careers.link,
        credits_spent: credits,
      });
    }

    // no careers link — inferred count from snippet text, if any
    for (const r of results) {
      const m = /(\d[\d,]*)\s+[\w\s]*jobs?\b/i.exec(`${r.title} ${r.description}`);
      if (m) {
        const n = parseInt(m[1]!.replace(/,/g, ''), 10);
        items.push({
          key: 'jobs:count',
          type: 'job_count',
          open_roles: n,
          value: String(n),
          basis: 'serp-snippet',
        });
        excerpts.push(`${r.title} — ${r.description}`);
        break;
      }
    }
    if (items.length === 0) {
      for (const r of results) excerpts.push(`${r.title} — ${r.description}`);
    }

    return envelope(company, 'jobs', deps, {
      items,
      raw_excerpt: clip(excerpts.join('\n')),
      source_url: searchUrl,
      credits_spent: credits,
    });
  } catch (e) {
    return failed(company, 'jobs', deps, e, searchUrl, credits);
  }
};
