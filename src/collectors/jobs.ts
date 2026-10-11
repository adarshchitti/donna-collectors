import { load } from 'cheerio';
import {
  failed,
  type Collector,
  type CanonicalCompany,
  type Fetcher,
  type FetchResult,
  type Item,
} from '../contract.js';
import { assertUnblocked, clip, envelope, nameMatches, parseSerp, slug, textAt } from '../util.js';

/**
 * jobs — open-role count and titles (inferred trust).
 *
 * PRIMARY: Bright Data's Indeed job-listings dataset
 * (gd_l4dx9j9sscpvs7no2, ~7.4M records), filtered by company name through
 * the Marketplace Dataset API. Broader than any one careers page, but
 * STALER — each item carries `as_of` (the freshest posting date in the
 * returned records) because fetched_at is the download time, and a user
 * needs the date the fact was true, not the day we pulled it.
 *
 * FALLBACK: the original SERP path — `"<name>" careers open positions`,
 * then unlock the first careers-shaped result — used whenever the fetcher
 * has no dataset() method (ReplayFetcher) or the dataset call fails. The
 * failure is surfaced on a meta item, never hidden.
 */
const INDEED_DATASET = 'gd_l4dx9j9sscpvs7no2';
const DATASET_LIMIT = 100;

interface DatasetCapable extends Fetcher {
  dataset(
    datasetId: string,
    filter: { name: string; operator: string; value: string },
    recordsLimit?: number,
  ): Promise<FetchResult>;
}
function hasDataset(f: Fetcher): f is DatasetCapable {
  return typeof (f as Partial<DatasetCapable>).dataset === 'function';
}

export function jobsQuery(company: CanonicalCompany): string {
  return `"${company.canonical_name}" careers open positions`;
}

const CAREERSISH = /career|jobs\.|greenhouse|lever\.co|workdayjobs|myworkdayjobs|ashbyhq|icims|bamboohr|jobvite|smartrecruiters/i;

/** Read the first present string field out of a heterogeneous record. */
function pick(r: Record<string, unknown>, ...fields: string[]): string {
  for (const f of fields) {
    const v = r[f];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

export const collect: Collector = async (company, deps) => {
  const query = jobsQuery(company);
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=us&hl=en`;
  let credits = 0;
  let datasetError: string | null = null;

  try {
    // --- dataset path (LiveFetcher only; ReplayFetcher has no dataset()) ---
    if (hasDataset(deps.fetcher)) {
      try {
        const res = await deps.fetcher.dataset(
          INDEED_DATASET,
          { name: 'company_name', operator: 'includes', value: company.canonical_name },
          DATASET_LIMIT,
        );
        credits += res.credits_spent;
        const records = (JSON.parse(res.body) as Record<string, unknown>[]) ?? [];

        // the dataset filter is fuzzy; keep only records whose company
        // field actually names us or an alias
        const mine = records.filter((r) =>
          nameMatches(company, pick(r, 'company_name', 'company', 'employer')),
        );

        const items: Item[] = [];
        const excerpts: string[] = [];
        const byTitle = new Map<string, { title: string; postings: number; posted: string; location: string }>();
        let asOf = '';
        for (const r of mine) {
          const title = pick(r, 'job_title', 'title', 'position');
          if (!title) continue;
          const posted = pick(r, 'job_posted_date', 'date_posted', 'posted_date', 'post_date', 'discovery_date');
          const location = pick(r, 'job_location', 'location', 'city');
          if (posted && posted > asOf) asOf = posted;
          const k = slug(title);
          const prev = byTitle.get(k);
          if (prev) prev.postings += 1;
          else byTitle.set(k, { title, postings: 1, posted, location });
        }

        for (const [k, t] of byTitle) {
          const item: Item = {
            key: `jobs:title:${k}`,
            type: 'job_title',
            title: t.title,
            postings: t.postings,
          };
          if (t.posted) item.posted = t.posted;
          if (t.location) item.location = t.location;
          items.push(item);
          excerpts.push(`${t.title}${t.location ? ` — ${t.location}` : ''}${t.posted ? ` (posted ${t.posted})` : ''}`);
        }
        items.push({
          key: 'jobs:count',
          type: 'job_count',
          open_roles: mine.length,
          value: String(mine.length),
          basis: 'indeed-dataset',
        });
        items.push({
          key: 'meta:dataset',
          type: 'meta',
          field: 'jobs_dataset',
          dataset_id: INDEED_DATASET,
          records: records.length,
          matched: mine.length,
          as_of: asOf,
          value: asOf,
        });

        return envelope(company, 'jobs', deps, {
          items,
          raw_excerpt: clip(excerpts.join('\n')),
          source_url: 'https://www.indeed.com/',
          credits_spent: credits,
        });
      } catch (e) {
        datasetError = e instanceof Error ? e.message : String(e);
      }
    }

    // --- SERP fallback (also the replay path) ---
    const res = await deps.fetcher.serp(query);
    credits += res.credits_spent;
    const results = parseSerp(res.body);

    const items: Item[] = [];
    const excerpts: string[] = [];
    if (datasetError) {
      items.push({
        key: 'meta:dataset',
        type: 'meta',
        field: 'jobs_dataset',
        dataset_id: INDEED_DATASET,
        value: `unavailable — ${datasetError}`,
      });
    }

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
    const msg = e instanceof Error ? e.message : String(e);
    return failed(
      company,
      'jobs',
      deps,
      datasetError ? `${msg} (dataset path also failed: ${datasetError})` : e,
      searchUrl,
      credits,
    );
  }
};
