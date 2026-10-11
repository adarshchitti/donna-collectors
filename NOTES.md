# Collector notes — per source

## Validation status (updated 2026-10-10)

| source | SERP/query half | page-body half |
|---|---|---|
| news | **validated against a real page** — live capture, `"Battelle" news`, 2026-10-10 | fixture-only, unvalidated (no unlocker zone) |
| executives | **validated against a real page** — live capture, `"Bath & Body Works" ...`, 2026-10-10 | fixture-only, unvalidated (authored PR page) |
| jobs | **validated against a real page** — live capture, `Battelle careers open positions`, 2026-10-10 | fixture-only, unvalidated (authored careers page) |
| registry | n/a | fixture-only, unvalidated (no unlocker zone) |
| court | n/a | fixture-only, unvalidated (no unlocker zone) |
| regulator | n/a | fixture-only, unvalidated (no unlocker zone) |
| layoffs | n/a | fixture-only, unvalidated (no unlocker zone) |
| domain | n/a | fixture-only, unvalidated (no unlocker zone) |

`brightdata zones` as of 2026-10-10 still lists only `serp_api1` — no Web
Unlocker zone. Live-call log: 2 calls spent on the executives recapture
(first returned HTTP 200 with a 0-byte body — transient; retry succeeded),
5 probe calls for entity-number discovery (one empty body, retried).

## Ohio company universe (ohio-companies.json)

30 real Ohio-registered companies, weighted toward Franklin County because
the court collector covers Franklin County Common Pleas, and toward names
with real court/WARN history (Big Lots, Express, FirstEnergy-HB6, Diebold
Nixdorf, Smucker, Dana...). `registry_id` is EMPTY for every entry — on
purpose:

- `site:` queries return 0 results through the SERP zone (operator appears
  unsupported — verified on businesssearch.ohiosos.gov and opencorporates).
- Entity numbers do not appear in ordinary SERP snippets either; they only
  live on the SoS detail page itself (SPA, needs the missing unlocker zone)
  or on aggregator detail pages (also need unlock).
- Probes recorded under `fixtures/discovery/` for provenance. Fill
  `registry_id` from the SoS details page once an unlocker zone exists —
  a wrong entity number is worse than none.

Shared context:

- **Fetch layer.** `src/fetcher/live.ts` posts to
  `https://api.brightdata.com/request` (`{zone, url, format: "raw"}`) and caches
  every response by `zone | UTC day | url` in memory and, if `cacheDir` is set,
  on disk. A same-day re-run costs zero credits. `src/fetcher/replay.ts` serves
  the same `Fetcher` interface from `fixtures/` — the whole suite runs offline.
- **SERP zone** (`serp_api1`) returns *parsed JSON*:
  `{general, organic:[{title, link, description, rank, date?}], ...}`.
  `parseSerp` in `src/util.ts` guards the 200-with-text-body case
  ("This target URL isn't supported with SERP API..."), which is how a
  wrong-zone call fails — it is NOT an HTTP error.
- **Geo must be pinned in the URL** (`gl=us&hl=en`); a `country` field in the
  request body is silently ignored (defaults drifted to Egypt/Argentina).
- **Unlocker zone does not exist yet.** `registry`, `court`, `regulator`,
  `layoffs`, `domain`, and the article-body half of `news`/`executives`/`jobs`
  are built against saved fixtures and will work live the moment
  `BRIGHTDATA_UNLOCKER_ZONE` is set — the code paths are identical.
- **Blocked pages return HTTP 200** with a challenge body. `assertUnblocked`
  in `src/util.ts` throws on captcha/denied markers before parsing; every
  collector calls it.
- **Empty is not an error.** An "ok" envelope with `items: []` means "we
  checked, nothing there". `ok: false` means "we could not check".

## registry — Ohio SoS business details

- URL: `https://businesssearch.ohiosos.gov/?businessDetails/<registry_id>`
  where `registry_id` is the entity number on the canonical company.
- Selectors: `.entity-info dt/dd` pairs (Status etc.),
  `.statutory-agent` (registered address), `.principals-table tbody tr`
  (officers), `.filings-table a.f-doc[href*="filingDetails/<id>"]` (filing
  ids live in the link, not the row), `.prior-names-list li`.
- The site is an SPA; the Unlocker returns the rendered details pane.
  Not-found entities render a `.no-results` page — treated as a legit empty.

## court — Franklin County Common Pleas (fcdcfcjs.co.franklin.oh.us)

- URL: `https://fcdcfcjs.co.franklin.oh.us/CaseInformationOnline/partySearch?name=<name>`
  (party-name search, which is what counterparty monitoring needs).
- Selectors: `.party-results tbody tr`, docket number from
  `a.case-link[href*="caseNumber="]` (compact form `26CV002147` is the key).
- **The portal lags real filings by 2–5 business days.** It states its own
  currency date in `.current-through`; we emit it as item
  `meta:current_through` so the system can honestly say "court records
  current to <date>" instead of implying the docket is live. Even an empty
  party search still reports the currency date.

## regulator — Ohio eLicense + OFAC SDN (two unlocks, one envelope)

- URLs: `https://elicense.ohio.gov/OH_VerifyLicense?searchType=entity&name=<name>`
  and `https://sanctionssearch.ofac.treas.gov/Search.aspx?name=<name>`.
- Selectors: `.license-results tbody tr`, `.actions-table tbody tr`
  (enforcement actions), `.sdn-table tbody tr` (SDN matches).
- **A failure in either sub-source fails the whole envelope.** An "ok"
  snapshot that silently skipped OFAC would read as "no sanctions" — the
  exact false-negative this product exists to prevent.
- `sanctions:<list>:<match>` keys name the *matched party* (e.g. a fuzzy
  `NORDVAL MATERIALS TRADING FZE` at score 83), not our company — same match,
  same key, and the score diff is visible as an altered record.

## layoffs — Ohio JFS WARN notices

- URL: `https://jfs.ohio.gov/warn/warnnotices.stm` — single listing page
  (current year) with one row per notice; **all Ohio filers share the page**,
  so rows are filtered by canonical name + aliases.
- Selectors: `.warn-table tbody tr`; notice id comes from the linked PDF
  filename (`a.w-link[href]`), the portal's own stable identifier. Fallback
  is `slug(company)-<notice-date digits>` — deterministic, never a row index.
- Only the current year is listed; prior years are separate pages we do not
  crawl (budget rule: the one page we need).

## news — SERP, then unlock article bodies

- Query: `"<canonical name>" news`; `organic[]` gives headline/outlet/date.
- Then the top `MAX_ARTICLE_UNLOCKS = 3` links are unlocked for body text
  (`article` → `main` → `p` fallback). Every SERP row becomes an item — the
  row itself is an observation — with `unlocked: true/false` and
  `unlock_error` when an article fails. **One blocked article is an
  item-level gap, never an envelope failure.**
- `key = article:<sha1(url)>`; `headline_norm` is set on every item so the
  differ collapses syndicated reposts into one.
- Healthy fixture (`fixtures/news/serp-healthy.json`) is a real live capture
  via `tools/capture-serp.mjs`.

## executives — SERP + press releases

- Query: `"<name>" appoints OR names OR joins OR departs CEO OR CFO OR president`.
- Move extraction runs on the **title first**, then title+description —
  person/role regexes bleed across the boundary otherwise. Departure
  patterns are tried before appointment ones.
- `key = move:<person-slug>:<role-slug>:<yyyy-mm-dd|undated>`. Date comes
  from the SERP `date` field; `undated` keeps the key stable when absent.
- The top matching link is unlocked once for the press-release body; a
  failure there is non-fatal (SERP row is still the record).

### Bugs found by validating against a real SERP (2026-10-10)

The hand-authored fixture was flattering; the real Bath & Body Works SERP
broke the extractor three ways:

1. **"Appoints X as Y" uncovered.** The dominant press-release phrasing
   ("Bath & Body Works Appoints Daniel Heaf as Chief Executive Officer" —
   the actual primary press release) matched no pattern; only `names?` was
   handled. Now `(?:names?|appoints?|taps?)`.
2. **PERSON swallowed connectives.** Under `/i`, `[A-Z]` matches lowercase,
   so "Appoints Daniel Heaf **as** ..." captured person `"Daniel Heaf as"`,
   and "Appoints Insider as Interim CFO" produced `"Insider as Interim"`.
   PERSON's first letters are now case-locked with `(?-i:[A-Z])`.
3. **Same move, two keys.** "Chief Executive Officer" and "CEO" minted
   different move keys for the identical fact across outlets. Role is now
   canonicalized for the key (`chief <x> officer` → `c?o` acronym); the raw
   title stays in the item's `role` field. Result on the real SERP: four
   outlets collapse to `move:daniel-heaf:ceo:undated`.
4. Also hardened: the departure pattern's role group is now required —
   "X steps down" with no role crashed on `undefined.trim()` and poisoned
   the whole envelope; and `resigned`/`stepped down`/`has`/`will` variants
   are covered.

## jobs — SERP → careers page

- Query: `"<name>" careers open positions`. The first careers-shaped link
  (`career|jobs.|greenhouse|lever|workday|ashby|icims|bamboohr|jobvite`)
  is unlocked; job titles read from `a.job-title`.
- `jobs:count` carries `open_roles` and `basis`: `careers-page` when parsed
  from the page, `serp-snippet` when inferred from text like
  "75 X Jobs in Columbus" — weaker evidence, marked as such.
- If SERP shows no careers link, **no URL is guessed** (speculative fetches
  are banned); the snippet-count fallback or an empty item set is what you get.
- Healthy SERP fixture is a real live capture; the careers HTML is authored.

## domain — WHOIS + homepage fingerprint

- URLs: `https://www.whois.com/whois/<domain>` then `https://<domain>/`.
  Both must succeed or the envelope fails (same rule as `regulator`).
- WHOIS is parsed from the raw `Label: value` block (`.whois-raw`/`pre`) —
  registrar, registered, expires, updated, sorted name-server list.
- `home:hash` is sha1 of the *raw body bytes*, so any byte-level change to
  the homepage is a diff; `home:title` is the `<title>`. A parked page
  yields a hash but no title item — that asymmetry is correct.
- A company with no `domains[0]` fails honestly with
  "canonical company has no domain".
