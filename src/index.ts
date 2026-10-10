import type { Collector, Source } from './contract.js';
import { collect as registry } from './collectors/registry.js';
import { collect as court } from './collectors/court.js';
import { collect as regulator } from './collectors/regulator.js';
import { collect as layoffs } from './collectors/layoffs.js';
import { collect as news } from './collectors/news.js';
import { collect as executives } from './collectors/executives.js';
import { collect as jobs } from './collectors/jobs.js';
import { collect as domain } from './collectors/domain.js';

/** The eight collectors, one per source id from the contract. */
export const collectors: Record<Source, Collector> = {
  registry,
  court,
  regulator,
  layoffs,
  news,
  executives,
  jobs,
  domain,
};

export { LiveFetcher } from './fetcher/live.js';
export { ReplayFetcher } from './fetcher/replay.js';
export type { Collector, CollectorDeps, CollectorEnvelope, CanonicalCompany, Fetcher, Source } from './contract.js';
