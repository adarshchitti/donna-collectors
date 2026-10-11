import { failed, type Collector } from '../contract.js';

/**
 * layoffs — UNAVAILABLE: the Ohio JFS WARN notice list
 * (jfs.ohio.gov/warn/warnnotices.stm) is a government domain Bright Data
 * refuses to fetch by policy (x-brd-error on HTTP 200).
 *
 * Non-government WARN aggregators were investigated: warntracker.com is a
 * generic SPA with no usable notices endpoint (live probe 2026-10-10), and
 * the Bright Data dataset marketplace has no WARN dataset. There is no
 * reachable per-company WARN source — the source fails visibly rather than
 * reporting "no layoffs".
 *
 * The old row-level parser (Ohio JFS .warn-table markup) is in git history
 * if a non-government mirror ever becomes fetchable.
 */
export function warnUrl(): string {
  return 'https://jfs.ohio.gov/warn/warnnotices.stm';
}

export const collect: Collector = async (company, deps) =>
  failed(
    company,
    'layoffs',
    deps,
    'layoffs unavailable: Bright Data blocks government domains ' +
      '(jfs.ohio.gov); no reachable non-government WARN substitute',
  );
