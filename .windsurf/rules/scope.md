# Scope — read this before acting

You are implementing **Track A of Donna: eight collectors**, in this repo only.
`BRIEF.md` is the full specification. `src/contract.ts` is the fixed contract.

## Stay inside these lines

**Write only inside this repository.** Everything you need is here. Never write,
move, or delete anything outside `/Users/adarshc/Desktop/donna-collectors`.

**Never modify `src/contract.ts`.** It is the boundary another five packages are
already built against. If it seems wrong, write the problem down in your notes
and work around it; do not edit it.

**Never read or print credentials.** `BRIGHTDATA_API_KEY` is in the environment —
pass it through to a request, never log it, never write it to a file, never
commit it. Do not open `.env`, `.env.local`, or anything under `~/.ssh`,
`~/.aws`, `~/.config`, or `~/.local/share`.

**No network except Bright Data and the package registry.** `npm install` is
fine. Bright Data via `https://api.brightdata.com/request` is the only way to
reach a target site — never `fetch()`, `curl`, or `wget` a target directly. No
other hosts.

**Credit discipline is a hard limit.** There are 300 Bright Data credits for the
entire event and roughly 7 are already spent. Each live call costs one. Work from
saved fixtures in `fixtures/`; make a live call only to capture a fixture you do
not yet have, and never from a test. A suite that hits the network drains the
budget silently.

**Do not install global packages, change shell config, or touch git remotes.**
Local commits in this repo are expected and good. Do not push.

## What done means

Eight collectors, each returning a valid envelope for three cases — a healthy
page, an empty result, and a broken or blocked page. All three are tests, because
the empty and broken cases are what produce honest coverage reporting.

`npm test` and `npm run typecheck` both green, with no network access required.

## The one rule behind all the others

This system reports **observed change** and never asserts health. A collector
that fails must say so — `{ok: false, error}` — because a thrown exception
becomes silence, and silence reads as "nothing happened". That is the single
failure mode this product exists to prevent. Never swallow an error, never
invent an item, and never paraphrase `raw_excerpt`: a user clicks through from a
briefing sentence to that exact text to check the claim themselves.
