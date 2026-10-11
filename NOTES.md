# Collector notes — per source

## Validation status (updated 2026-10-11, live-run fix pass)

| source | fetch half | details |
|---|---|---|
| registry | **validated against a real page** — live captures of the OpenCorporates us_oh search AND company page, 2026-10-10 (Big Lots) | officer items fixture-only (OC login-gates officers on the captured page) |
| court | **validated against a real page** — live capture of the CourtListener v4 search API, 2026-10-10 (63KB JSON) | `insolvency_filing`/`stayed` paths exercised on a schema-modeled fixture carrying the real Big Lots Ch.11 docket (see below) |
| regulator | **UNAVAILABLE** | both sub-sources verified blocked live 2026-10-10 |
| layoffs | **UNAVAILABLE** | jfs.ohio.gov blocked; no reachable non-gov WARN source |
| news | SERP **validated against a real page** — earlier live capture | article-body half fixture-only, unvalidated |
| executives | SERP **validated live 2026-10-11** (after the transient-refusal fix below; the same query had failed on `expect_element`) | PR body fixture-only, unvalidated |
| jobs | SERP **validated against a real page** — earlier live capture | careers page fixture-only; **Indeed dataset path implemented, stub-tested, NOT yet validated live** |
| domain | **BLOCKED live 2026-10-11** — whois.com serves a captcha challenge (37KB page, detected by `util.block`) | the collector fails visibly rather than parsing the challenge; needs a different whois source (RDAP?) before it yields anything |

## Bright Data refuses government domains — the fix that made this visible

Bright Data classifies government domains as un-fetchable by policy. The
refusal arrives as **HTTP 200 with a zero-byte body**; the real failure only
lives in response headers: `x-brd-error`, `x-brd-error-code`, and
`x-brd-status-code`. `LiveFetcher` used to treat that as a successful empty
fetch — a silent false negative. It now **throws** when `x-brd-error` is
present, naming the URL and quoting the header
(`src/fetcher/live.ts`, covered by `src/fetcher/live.test.ts`).

Verified blocked this session (live calls, 2026-10-10):

- `businesssearch.ohiosos.gov` (registry)
- `fcdcfcjs.co.franklin.oh.us` (court)
- `jfs.ohio.gov` (layoffs)
- `sanctionslistservice.ofac.treas.gov` (OFAC)
- `elicense.ohio.gov` (licences) — blocked too; the licence half is also gone
- `sec.gov`

Also refused, by a different mechanism: `opensanctions.org` returns
`x-brd-error-code: policy_20140` (residential robots.txt/KYC policy) — so the
standard non-government OFAC mirror is *not* reachable either.

Blocked domains are never fetched — the refusal is deterministic and a
refused call still risks billing, so `regulator` and `layoffs` fail fast with
`{ok:false}` before any request.

## `x-brd-error` is TWO different failures — do not treat them alike

A policy refusal and a render failure arrive in the same clothes: HTTP 200,
reason only in `x-brd-*` headers, `x-brd-status-code: 502` either way. They
need opposite handling, and conflating them cost a working source:

- **policy** — `elicense.ohio.gov` → "classified as Government and blocked by
  Bright Data"; `opensanctions.org` → `policy_20140` (robots/KYC). Permanent.
  Retrying is pure waste and may still bill. Never retry.
- **transient** — the executives SERP, live 2026-10-11:
  `x-brd-error-code: expect_element`, "waiting for selector `#main` failed:
  timeout 30000ms exceeded". Bright Data failed to RENDER an allowed page.
  The same query succeeded on the next attempt.

`classifyBrdError()` in `src/fetcher/live.ts` sorts them on the error code and
message (never the status, which is 502 for both): anything matching
`policy_*` or the government/robots/KYC wording is policy and throws at once;
everything else is transient and goes through a bounded retry (2 retries,
500ms exponential backoff) before throwing an error that says, in words, that
it was *not* a policy refusal. Covered by `src/fetcher/live.test.ts`.

Why it mattered: the pre-fix behaviour reported `expect_element` as
"REFUSED BY POLICY (not an empty result)" in the credit report, which reads as
"this source is unreachable, stop trying" about a 30-second timeout.

## Credentials for `--live` — `.env`, and a preflight

`--live` previously needed the key and both zones exported in the shell; with
nothing set, a run failed per-source with "BRIGHTDATA_UNLOCKER_ZONE is not
set" — six of the eight collectors unlock a page, so that is most of a pass
failing on an unset variable while looking like a Bright Data outage.

- `src/env.ts` reads `.env` (then `.env.local`), gitignored, shell wins.
  See `.env.example`. Our zones are `web_unlocker1` / `serp_api1`.
- `src/cli.ts` checks all three variables BEFORE the first fetch and exits 2
  naming every missing one.

**Cache rollover gotcha:** the `.cache/` key is zone + URL + **UTC day**. At
UTC midnight every entry stops matching, so the first live run after 00:00 UTC
refetches and rebills everything. That is by design (evidence should not be
stale) but it means "it worked an hour ago" is not evidence it still will.

## New item types — for the rules table

New `item.type` values emitted by this pass, so rules can classify them
(an unclassified type is invisible, not an error):

- **`insolvency_filing`** — emitted by `court` for a bankruptcy docket
  (key `insolvency:<court_id>:<docket>`; fields `docket_number`, `case_name`,
  `court`, `court_id`, `docket_type`, `suit_nature`, `cause`, `chapter`,
  `filed`, `status`, `party`, `docket_url`, `trustee`). Tier 1.
- **`change_of_control`** — emitted by `registry` for filings whose type is a
  control transfer (MERGER/CONSOLIDATION/ACQUISITION/TAKEOVER/DEMERGER —
  matched on OC filing types like `MERGER/DOMESTIC`, `MERGER/FOREIGN`).
  Key `change_of_control:<oc filing id>`; fields `filing_id`, `filing_type`,
  `date`, `description`, `evidence`. Tier 1.
- **`case` with `status` containing `stayed`** — a civil docket that reports
  a stay (e.g. `cause: "11 U.S.C. 362 Suggestion of Bankruptcy"`). Note the
  deliberate boundary: a case *stayed by* bankruptcy is a `case`, not an
  `insolvency_filing` — only the bankruptcy docket itself is insolvency.
- `meta` items gained new fields: `meta:entity_number` (registry — the SoS
  entity number, now observable via OC), `meta:result_count` (court),
  `meta:dataset` (jobs — dataset id, record counts, `as_of`).

## Bright Data dataset marketplace — investigated 2026-10-10

`GET https://api.brightdata.com/datasets/list` → 1,857 datasets. **No
sanctions, court, WARN, or government-registry datasets exist** — the
marketplace is commercial data only, so it cannot rescue the blocked sources.

API shape (documented): `POST /datasets/filter` `{dataset_id, records_limit,
filter:{name, operator, value}}` → `snapshot_id`; poll
`GET /datasets/v3/progress/<id>` until `ready`; download
`GET /datasets/v3/snapshot/<id>?format=json`. Billing is **per returned
record** (~$2.5 CPM), not per call — `records_limit` bounds it. A sync
`POST /datasets/search/:dataset_id` exists but covers only 3 LinkedIn
datasets (alpha).

`LiveFetcher.dataset(id, filter, limit)` implements trigger → poll →
download with the same day-cache as `/request` calls. It is not on the
contract `Fetcher` interface — collectors feature-detect it
(`typeof fetcher.dataset === 'function'`); ReplayFetcher has no `dataset`,
so replay always exercises the non-dataset path.

**Where it is used:** `jobs` prefers the Indeed dataset
`gd_l4dx9j9sscpvs7no2` (7.4M listings, `company_name includes <canonical>`,
limit 100), then re-checks `company_name` client-side. On ANY dataset error
it falls back to the SERP path and marks the attempt on `meta:dataset` —
never silently.

**Trade-off noted:** a dataset is broader but staler than a live fetch.
`fetched_at` is fixed by the contract to the download time, so dataset
currency rides in items instead: `meta:dataset.as_of` (freshest posting date
in the returned records) and per-title `posted`. A user clicking through
sees the date the fact was true, not the day we pulled it.

Candidates not yet wired: LinkedIn company info
(`gd_l1vikfnt1wgvvqz95w` / `gd_lbgqn2movva0ntlmz`, 55M — officers/identity
for `executives`/`registry`) and Crunchbase companies
(`gd_l1vijqt9jfj7olije`, 2.3M — funding/acquisition events →
`change_of_control`). `registry` already emits `change_of_control` from OC
merger filings (validated); these stay documented options.

## registry — OpenCorporates us_oh (REPLACES Ohio SoS)

- Search: `https://opencorporates.com/companies/us_oh?q=<canonical name>`;
  pick best `li.search-result.company` by name match — exact normalized
  name > core-name (suffixes stripped) > "Previously/Alternatively known as"
  hint in `span.slight_highlight`. Then unlock the company page
  `/companies/us_oh/<company number>`. Two unlocks per run.
- Company page selectors (validated on the live Big Lots capture):
  `dd.company_number`, `dd.status`, `dd.registered_address li.address_line`,
  `dd.previous_names li.name_line`, `dd.other_identifiers a.identifier`,
  `#filings .filing` (id `filing_<n>`, `.subhead a.filing` = type,
  `.dateline` = date).
- **Name changes break naive matching** — the real Big Lots entity is now
  "FORMER BL STORES, INC."; it is found only through its
  previously-known-as hint.
- **Gaps vs SoS:** officers are login-gated on some OC pages ("N officers
  available, please log in") — officer items are emitted only when the list
  is public. No statutory agent, no filing PDFs.
- Bonus: `meta:entity_number` now supplies the entity number that
  `ohio-companies.json` could not fill (see below).

## court — CourtListener REST API (REPLACES Franklin County Common Pleas)

- `GET https://www.courtlistener.com/api/rest/v4/search/?q="<name>"&type=r`
  → JSON `{count, results:[{docketNumber, caseName, court, court_id,
  jurisdictionType, chapter, cause, suitNature, dateFiled, dateTerminated,
  party[], trustee_str, docket_absolute_url}]}` — no HTML parsing needed.
- **An upgrade, not a workaround:** RECAP covers federal bankruptcy dockets —
  the counterparty Chapter 11 that no previous source could see.
- `type=r` is full-text; only rows where the company/alias is a **party** or
  in the caption become items (the rest are mentions).
- `status`: `stayed` when the record's own text reports a stay,
  `terminated <date>` when `dateTerminated` is set, else `open`.
- **Gaps:** county/state courts are out of scope — the Franklin County
  coverage is gone, not moved. Only the first results page is read (one
  fetch per run; for heavily-litigated names a bankruptcy docket can sit
  past page 1 — the Big Lots Ch.11 is real on CourtListener but not in the
  captured first page).
- `fixtures/court/courtlistener-search-insolvency.json` is **schema-modeled**
  on the real capture and carries the real Big Lots Ch.11 docket
  (`1:24-bk-11885`, Bankr. D. Del., filed 2024-09-09) — it exercises
  classification, it is not a live capture.

## regulator — UNAVAILABLE

- `elicense.ohio.gov` and `sanctionssearch.ofac.treas.gov` both verified
  blocked live. opensanctions.org (standard OFAC mirror) refused under
  `policy_20140` (robots/KYC). No non-government per-company SDN query
  exists; no licence mirror exists; no marketplace dataset exists.
- Envelope: `{ok:false, error:'regulator unavailable: Bright Data blocks
  government domains ...'}`, `credits_spent: 0` — a visible gap, not a fake
  "no sanctions". Old parsers are in git history.

## layoffs — UNAVAILABLE

- `jfs.ohio.gov` verified blocked. warntracker.com probed live — generic
  SPA, no usable notices endpoint. No WARN marketplace dataset. Same
  visible `{ok:false}` treatment, `credits_spent: 0`.

## jobs — SERP/careers + Indeed dataset

- Live (LiveFetcher): Indeed dataset first, SERP fallback — see dataset
  section above. Replay (no `dataset()`): the original SERP → careers-page
  path, unchanged.
- `basis` on `jobs:count`: `indeed-dataset` | `careers-page` | `serp-snippet`.

## Ohio company universe (ohio-companies.json)

30 real Ohio-registered companies. `registry_id` is EMPTY for every entry —
the SoS detail page was unreachable before and the site: operator is
unsupported by the SERP zone. **Now fillable** from the OpenCorporates
`meta:entity_number` item (OC's company number is the Ohio entity number —
verified: Big Lots → `1215332` matches the SoS-format number).

## fixtures/pairs/ — differ replay pack

- `court` pair rewritten to CourtListener vocabulary: after adds
  `insolvency:deb:1:24-bk-11885` (type `insolvency_filing`) — the differ now
  sees the tier-1 signal appear.
- `layoffs` pair retained as synthetic differ-semantics data only — it does
  NOT imply live coverage; the source is unavailable.
- `registry` pair unchanged (key vocabulary is stable across the source
  swap: `status:current`, `officer:`, `filing:`).

## CLI — `npm run collect`

Replay default unchanged. registry/court replay the real Big Lots captures
(`--company "Big Lots, Inc."`); replaying other companies exercises the code
path against Big-Lots evidence. `regulator`/`layoffs` return the honest
`ok:false` in every mode — they never fetch.

Shared context:

- **Fetch layer.** `LiveFetcher` posts to `api.brightdata.com/request`
  (zone+URL+UTC-day cache, memory + optional disk) and now also exposes
  `dataset()` for the Marketplace Dataset API. **x-brd-error headers are a
  hard error** — see the top section.
- **Unlocker zone exists now** (`BRIGHTDATA_UNLOCKER_ZONE` is set); the
  earlier "no unlocker zone" caveat is stale.
- **Empty is not an error.** `ok` with `items:[]` means checked-and-clear;
  `ok:false` means could-not-check. Sources with no reachable substitute
  return `ok:false` by design.
- Live-call log this session: datasets/list (1), two wrong-endpoint probes
  (2), four source probes — OC search, CourtListener API, opensanctions
  (refused), elicense (refused) — OC company page, warntracker probe. ~9 of
  the 10-call budget spent.
