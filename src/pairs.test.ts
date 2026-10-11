import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectorEnvelopeSchema, type CollectorEnvelope } from './contract.js';

/**
 * fixtures/pairs/ — before/after snapshot pairs that exercise the downstream
 * differ. Every file must be a valid envelope and every pair must produce the
 * intended observable change: a record removed, a record altered (same key,
 * different value), or a record added.
 */
const PAIRS_DIR = join(import.meta.dirname, '..', 'fixtures', 'pairs');
const SOURCES = ['registry', 'court', 'layoffs', 'jobs', 'domain', 'news'] as const;

function load(name: string): CollectorEnvelope {
  const raw = JSON.parse(readFileSync(join(PAIRS_DIR, name), 'utf8'));
  return collectorEnvelopeSchema.parse(raw);
}

const pair = (s: string) => ({ before: load(`${s}.before.json`), after: load(`${s}.after.json`) });
const keys = (e: CollectorEnvelope) => new Set(e.items.map((i) => i.key));

describe('fixtures/pairs replay pack', () => {
  it('every snapshot is a valid collector envelope', () => {
    for (const s of SOURCES) {
      const { before, after } = pair(s);
      expect(before.source).toBe(s);
      expect(after.source).toBe(s);
      expect(before.ok).toBe(true);
      expect(after.ok).toBe(true);
      expect(before.company_id).toBe(after.company_id);
    }
  });

  it('registry: CFO officer removed and status altered, same key', () => {
    const { before, after } = pair('registry');
    expect(keys(before).has('officer:jonathan-ramsden:cfo')).toBe(true);
    expect(keys(after).has('officer:jonathan-ramsden:cfo')).toBe(false);

    // status must be ALTERED (same key, new value) — not remove+add
    const bStatus = before.items.find((i) => i.key === 'status:current');
    const aStatus = after.items.find((i) => i.key === 'status:current');
    expect(bStatus?.value).toBe('Active');
    expect(aStatus?.value).toBe('Cancelled');
  });

  it('court: a new docket appears', () => {
    const { before, after } = pair('court');
    expect(keys(before).has('case:26CV002147')).toBe(false);
    expect(keys(after).has('case:26CV002147')).toBe(true);
    expect(after.items.length).toBe(before.items.length + 1);
  });

  it('layoffs: a new WARN notice appears', () => {
    const { before, after } = pair('layoffs');
    expect(before.items).toHaveLength(0);
    expect(keys(after).has('notice:WARN-2026-187')).toBe(true);
    expect(after.items[0]?.employees_affected).toBe(214);
  });

  it('jobs: open roles drop sharply', () => {
    const { before, after } = pair('jobs');
    const b = before.items.find((i) => i.key === 'jobs:count');
    const a = after.items.find((i) => i.key === 'jobs:count');
    expect(b?.open_roles).toBe(75);
    expect(a?.open_roles).toBe(12);
    // two title records removed alongside the count change
    const removed = [...keys(before)].filter((k) => !keys(after).has(k));
    expect(removed.sort()).toEqual([
      'jobs:title:senior-materials-scientist',
      'jobs:title:store-manager-columbus',
    ]);
  });

  it('domain: only the homepage content hash changes', () => {
    const { before, after } = pair('domain');
    expect(keys(before)).toEqual(keys(after));
    const b = before.items.find((i) => i.key === 'home:hash');
    const a = after.items.find((i) => i.key === 'home:hash');
    expect(b?.content_hash).toBeTruthy();
    expect(a?.content_hash).toBeTruthy();
    expect(b?.content_hash).not.toBe(a?.content_hash);
  });

  it('news: three syndicated URLs collapse to ONE item via headline_norm', () => {
    const { before, after } = pair('news');
    // three distinct record keys, one headline_norm — the differ's collapse
    // key. The story appears once, not three times.
    const story = after.items.filter(
      (i) => i.headline_norm === 'big lots cfo jonathan ramsden departs company',
    );
    expect(story).toHaveLength(3);
    expect(new Set(story.map((i) => i.key)).size).toBe(3);
    expect(new Set(story.map((i) => i.url)).size).toBe(3);

    const beforeNorms = new Set(before.items.map((i) => i.headline_norm));
    const newNorms = new Set(
      after.items.map((i) => i.headline_norm).filter((n) => !beforeNorms.has(n)),
    );
    expect(newNorms).toEqual(new Set(['big lots cfo jonathan ramsden departs company']));
  });
});
