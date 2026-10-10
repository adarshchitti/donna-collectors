import { load } from 'cheerio';
import { failed, type Collector, type CanonicalCompany, type Item } from '../contract.js';
import { assertUnblocked, clip, envelope, nameMatches, slug } from '../util.js';

/**
 * layoffs — Ohio JFS WARN notice listing.
 *
 * URL pattern: https://jfs.ohio.gov/warn/warnnotices.stm — a single listing
 * page (current year) with one row per notice. Rows are matched against the
 * canonical name and aliases; the notice id comes from the linked PDF's
 * filename, which is the portal's own stable identifier for the record.
 *
 * Only rows naming the company become items — the page lists every Ohio
 * WARN filer, so unmatched rows are other companies' notices.
 */
export function warnUrl(): string {
  return 'https://jfs.ohio.gov/warn/warnnotices.stm';
}

export const collect: Collector = async (company, deps) => {
  const url = warnUrl();
  let credits = 0;
  try {
    const res = await deps.fetcher.unlocker(url);
    credits += res.credits_spent;
    assertUnblocked(res.body);
    const $ = load(res.body);

    const items: Item[] = [];
    const excerpts: string[] = [];

    $('.warn-table tbody tr').each((_i, el) => {
      const name = $(el).find('.w-company').text().replace(/\s+/g, ' ').trim();
      if (!name || !nameMatches(company, name)) return;

      const href = $(el).find('a.w-link').attr('href') ?? '';
      const pdf = /([^/]+)\.pdf$/i.exec(href)?.[1];
      const noticeDate = $(el).find('.w-notice-date').text().replace(/\s+/g, ' ').trim();
      // stable id: prefer the PDF filename; fall back to name+date slug
      const id = pdf ?? `${slug(name)}-${noticeDate.replace(/[^0-9]/g, '')}`;
      const layoffDate = $(el).find('.w-layoff-date').text().replace(/\s+/g, ' ').trim();
      const affected = $(el).find('.w-affected').text().replace(/\s+/g, ' ').trim();
      const county = $(el).find('.w-county').text().replace(/\s+/g, ' ').trim();

      items.push({
        key: `notice:${id}`,
        type: 'warn_notice',
        id,
        company: name,
        notice_date: noticeDate,
        effective_date: layoffDate,
        employees_affected: Number(affected) || affected,
        site: county ? `${county} County, OH` : '',
        notice_url: href ? new URL(href, 'https://jfs.ohio.gov').href : '',
      });
      excerpts.push(
        `Notice Date: ${noticeDate} | Company: ${name} | County: ${county} | ` +
        `Layoff/Closure Date: ${layoffDate} | Employees Affected: ${affected}`,
      );
    });

    return envelope(company, 'layoffs', deps, {
      items,
      raw_excerpt: clip(excerpts.join('\n')),
      source_url: url,
      credits_spent: credits,
    });
  } catch (e) {
    return failed(company, 'layoffs', deps, e, url, credits);
  }
};
