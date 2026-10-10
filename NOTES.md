# Collector notes — per source

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
  person/role regexes bleed across the boundary otherwise (a "Departure of
  COO Marcus Hall" title followed by "Nordvale Materials..." once produced
  `marcus-hall-nordvale-materials`). Departure patterns are tried before
  appointment ones.
- `key = move:<person-slug>:<role-slug>:<yyyy-mm-dd|undated>`. Date comes
  from the SERP `date` field; `undated` keeps the key stable when absent.
- The top matching link is unlocked once for the press-release body; a
  failure there is non-fatal (SERP row is still the record).

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
