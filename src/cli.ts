/**
 * collect — run one collector for one company and print the envelope as JSON.
 *
 *   npm run collect -- --source registry --company "Big Lots"        # replay
 *   npm run collect -- --source news --company 21 --live             # real fetch
 *   npm run collect -- --list
 *
 * REPLAY IS THE DEFAULT. Saved fixtures cost zero credits; a careless run
 * cannot spend money. `--live` opts in to real Bright Data fetches (cached
 * by zone+URL+UTC day under .cache/). `--dry-run` is accepted as an explicit
 * spelling of the default.
 *
 * Replay caveat: the fixtures are captures for specific companies (Battelle
 * for news/jobs, Bath & Body Works for executives, authored HTML for the
 * unlocker sources). Replaying for a different company exercises the full
 * code path but the items reflect the recorded evidence, not that company.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectors } from './index.js';
import { SOURCES, type CanonicalCompany, type Source } from './contract.js';
import { ReplayFetcher, serpKey, unlockerKey, type ReplayMap } from './fetcher/replay.js';
import { LiveFetcher } from './fetcher/live.js';
import { loadEnv, missingLiveEnv } from './env.js';
import { slug } from './util.js';
import { searchUrl as registrySearchUrl, companyUrl as registryCompanyUrl } from './collectors/registry.js';
import { searchUrl as courtSearchUrl } from './collectors/court.js';
import { newsQuery } from './collectors/news.js';
import { execQuery } from './collectors/executives.js';
import { jobsQuery } from './collectors/jobs.js';
import { whoisUrl, homeUrl } from './collectors/domain.js';

interface CompanyRecord {
  canonical_name: string;
  registry_id: string;
  jurisdiction: string;
  domains: string[];
  aliases: string[];
  notes?: string;
}

function usage(): never {
  console.error(
    'usage: npm run collect -- --source <source> --company <name|registry_id|index> [--live|--dry-run]\n' +
      `       sources: ${SOURCES.join(', ')}\n` +
      '       npm run collect -- --list',
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { source?: string; company?: string; live: boolean; list: boolean } {
  const out: { source?: string; company?: string; live: boolean; list: boolean } = { live: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--source') out.source = argv[++i];
    else if (a === '--company') out.company = argv[++i];
    else if (a === '--live') out.live = true;
    else if (a === '--dry-run') out.live = false;
    else if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') usage();
    else usage();
  }
  return out;
}

function loadCompanies(): CompanyRecord[] {
  const path = join(import.meta.dirname, '..', 'ohio-companies.json');
  return JSON.parse(readFileSync(path, 'utf8')) as CompanyRecord[];
}

function findCompany(list: CompanyRecord[], id: string): CompanyRecord | undefined {
  const needle = id.trim().toLowerCase();
  const byIndex = /^\d+$/.test(needle) ? list[Number(needle)] : undefined;
  return (
    list.find((c) => c.registry_id !== '' && c.registry_id === id.trim()) ??
    list.find((c) => c.canonical_name.toLowerCase() === needle) ??
    list.find((c) => c.aliases.some((a) => a.toLowerCase() === needle)) ??
    list.find((c) => slug(c.canonical_name) === slug(needle)) ??
    byIndex
  );
}

function toCanonical(c: CompanyRecord): CanonicalCompany {
  return {
    company_id: `oh-${slug(c.canonical_name)}`,
    canonical_name: c.canonical_name,
    jurisdiction: c.jurisdiction,
    registry_id: c.registry_id,
    aliases: c.aliases,
    domains: c.domains,
  };
}

/** URLs the collector will request, mapped to the saved fixture for each. */
function replayMap(company: CanonicalCompany, source: Source): ReplayMap {
  switch (source) {
    case 'registry':
      return {
        [unlockerKey(registrySearchUrl(company))]: 'registry/opencorporates-search-biglots.html',
        // the company page the collector picks out of the captured search
        [unlockerKey(registryCompanyUrl('1215332'))]: 'registry/opencorporates-company-biglots.html',
      };
    case 'court':
      return { [unlockerKey(courtSearchUrl(company))]: 'court/courtlistener-search-biglots.json' };
    case 'regulator':
    case 'layoffs':
      // both collectors fail visibly before any fetch (government domains)
      return {};
    case 'domain': {
      const d = company.domains[0];
      return d
        ? {
            [unlockerKey(whoisUrl(d))]: 'domain/whois-healthy.html',
            [unlockerKey(homeUrl(d))]: 'domain/home-healthy.html',
          }
        : {};
    }
    case 'news':
      return {
        [serpKey(newsQuery(company))]: 'news/serp-healthy.json',
        [unlockerKey('https://www.battelle.org/insights/newsroom')]: 'news/article-newsroom.html',
        [unlockerKey('https://www.battelle.org/')]: 'news/article-homepage.html',
        [unlockerKey('https://inside.battelle.org/')]: 'news/article-blog.html',
      };
    case 'executives':
      return {
        [serpKey(execQuery(company))]: 'executives/serp-healthy.json',
        [unlockerKey('https://investors.bbwinc.com/news-releases/news-release-details/bath-body-works-appoints-daniel-heaf-chief-executive-officer')]:
          'executives/pr-healthy.html',
      };
    case 'jobs':
      return {
        [serpKey(jobsQuery(company))]: 'jobs/serp-healthy.json',
        [unlockerKey('https://www.battelle.org/careers')]: 'jobs/careers-healthy.html',
      };
  }
}

const args = parseArgs(process.argv.slice(2));
const companies = loadCompanies();

if (args.list) {
  companies.forEach((c, i) =>
    console.log(`${i}\t${c.canonical_name}${c.registry_id ? `  [${c.registry_id}]` : ''}`),
  );
  process.exit(0);
}

if (!args.source || !args.company) usage();
if (!SOURCES.includes(args.source as Source)) {
  console.error(`unknown source "${args.source}" — expected one of: ${SOURCES.join(', ')}`);
  process.exit(2);
}
const source = args.source as Source;

const record = findCompany(companies, args.company);
if (!record) {
  console.error(`no company matches "${args.company}" — try --list`);
  process.exit(2);
}
const company = toCanonical(record);

if (args.live) {
  loadEnv();
  const missing = missingLiveEnv();
  if (missing.length > 0) {
    console.error(
      `--live needs ${missing.join(', ')} -- set them in .env (see .env.example) or in the ` +
        'shell. Zones are the names from the Bright Data console: web_unlocker1 / serp_api1. ' +
        'Drop --live to replay the saved fixtures for free.',
    );
    process.exit(2);
  }
}

const fetcher = args.live
  ? new LiveFetcher({ cacheDir: '.cache' })
  : new ReplayFetcher(replayMap(company, source), 'fixtures');

console.error(`mode: ${args.live ? 'LIVE (spends credits)' : 'replay (fixtures, 0 credits)'} | source: ${source} | company: ${company.canonical_name}`);

const env = await collectors[source](company, {
  fetcher,
  now: () => new Date().toISOString(),
  runId: `cli-${slug(company.canonical_name)}-${source}-${args.live ? 'live' : 'replay'}`,
});

console.log(JSON.stringify(env, null, 2));
if (!env.ok) process.exit(1);
