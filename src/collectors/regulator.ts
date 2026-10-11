import { failed, type Collector, type CanonicalCompany } from '../contract.js';

/**
 * regulator — UNAVAILABLE: both sub-sources are government domains that
 * Bright Data refuses to fetch by policy (x-brd-error on HTTP 200, verified
 * live 2026-10-10):
 *
 *   - Ohio eLicense   https://elicense.ohio.gov/OH_VerifyLicense?...   BLOCKED
 *   - OFAC SDN search https://sanctionssearch.ofac.treas.gov/...       BLOCKED
 *
 * Non-government substitutes were investigated and do not exist here:
 * opensanctions.org (the standard OFAC mirror) is refused by Bright Data's
 * residential robots.txt policy (x-brd-error-code: policy_20140), and no
 * other non-government source exposes a per-company SDN query. The Bright
 * Data dataset marketplace (1,857 datasets) has no sanctions list.
 *
 * The envelope FAILS visibly rather than reporting "no licences, no
 * sanctions" — silence here is the exact false negative the product exists
 * to prevent. To restore coverage, point a non-government sanctions mirror
 * or licence lookup at this collector; the old parsing logic is in git
 * history (Ohio eLicense + OFAC SDN selectors).
 *
 * These URL builders are kept so NOTES.md and any future substitute can
 * reference the verified-blocked endpoints.
 */
export function elicenseUrl(company: CanonicalCompany): string {
  return (
    'https://elicense.ohio.gov/OH_VerifyLicense?searchType=entity&name=' +
    encodeURIComponent(company.canonical_name)
  );
}
export function ofacUrl(company: CanonicalCompany): string {
  return (
    'https://sanctionssearch.ofac.treas.gov/Search.aspx?name=' +
    encodeURIComponent(company.canonical_name)
  );
}

export const collect: Collector = async (company, deps) =>
  failed(
    company,
    'regulator',
    deps,
    'regulator unavailable: Bright Data blocks government domains ' +
      '(elicense.ohio.gov, sanctionslistservice.ofac.treas.gov); no reachable non-government substitute',
  );
