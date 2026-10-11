import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveFetcher } from './live.js';

/**
 * Bright Data refuses targets it will not fetch (e.g. domains it classifies
 * as Government) with HTTP 200 and a zero-byte body — the failure lives ONLY
 * in x-brd-* response headers. Returning that as an empty FetchResult would
 * be a silent false negative, so LiveFetcher must throw instead.
 */
const GOV_URL = 'https://businesssearch.ohiosos.gov/?businessDetails/2447113';
const BRD_REFUSAL =
  'Access denied: businesssearch.ohiosos.gov is classified as Government ' +
  'and blocked by Bright Data as it might breach Bright Data usage policy';

function fetcher(): LiveFetcher {
  return new LiveFetcher({ apiKey: 'test-key', unlockerZone: 'unlocker_zone' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LiveFetcher', () => {
  it('throws on an HTTP 200 with x-brd-error instead of returning an empty body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('', {
          status: 200,
          headers: {
            'x-brd-error': BRD_REFUSAL,
            'x-brd-error-code': 'proxy_error',
            'x-brd-status-code': '502',
          },
        }),
      ),
    );

    await expect(fetcher().unlocker(GOV_URL)).rejects.toThrow(/x-brd-error/);
    // the error names the refused URL and quotes the header verbatim
    await expect(fetcher().unlocker(GOV_URL)).rejects.toThrow(GOV_URL);
    await expect(fetcher().unlocker(GOV_URL)).rejects.toThrow(
      'classified as Government',
    );
  });

  it('returns the body on a normal 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>ok</html>', { status: 200 })),
    );
    const res = await fetcher().unlocker('https://example.com/');
    expect(res.body).toBe('<html>ok</html>');
    expect(res.credits_spent).toBe(1);
  });

  it('throws the HTTP error on a non-2xx without x-brd headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream exploded', { status: 502 })),
    );
    await expect(fetcher().unlocker('https://example.com/')).rejects.toThrow(/HTTP 502/);
  });
});

/**
 * A render failure wears the same clothes as a policy refusal — HTTP 200,
 * x-brd-error, x-brd-status-code 502 — and was being treated as one: the
 * executives SERP came back `expect_element` ("waiting for selector \"#main\"
 * failed: timeout 30000ms exceeded") on a live pass, 2026-10-11, and the run
 * reported it as REFUSED BY POLICY without ever retrying.
 */
const RENDER_TIMEOUT = 'waiting for selector "#main" failed: timeout 30000ms exceeded';

const refusal = (error: string, code: string): Response =>
  new Response('', {
    status: 200,
    headers: { 'x-brd-error': error, 'x-brd-error-code': code, 'x-brd-status-code': '502' },
  });

const retrying = (): LiveFetcher =>
  new LiveFetcher({
    apiKey: 'test-key',
    unlockerZone: 'unlocker_zone',
    serpZone: 'serp_zone',
    maxRetries: 2,
    backoffMs: 0,
  });

describe('LiveFetcher transient refusals', () => {
  it('retries a render failure and returns the page the next attempt serves', async () => {
    const impl = vi
      .fn()
      .mockResolvedValueOnce(refusal(RENDER_TIMEOUT, 'expect_element'))
      .mockResolvedValueOnce(new Response('<html>second try</html>', { status: 200 }));
    vi.stubGlobal('fetch', impl);

    const res = await retrying().unlocker('https://example.com/');

    expect(res.body).toBe('<html>second try</html>');
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retries, and does not call it a policy refusal', async () => {
    const impl = vi.fn(async () => refusal(RENDER_TIMEOUT, 'expect_element'));
    vi.stubGlobal('fetch', impl);

    const err = await retrying()
      .unlocker('https://example.com/')
      .catch((e: unknown) => e as Error);

    expect(err.message).toContain('3 attempt(s)');
    expect(err.message).toContain('not blocked by policy');
    expect(err.message).toContain('expect_element');
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('never retries a policy refusal -- it will be refused every time', async () => {
    const impl = vi.fn(async () => refusal(BRD_REFUSAL, 'proxy_error'));
    vi.stubGlobal('fetch', impl);

    await expect(retrying().unlocker(GOV_URL)).rejects.toThrow('classified as Government');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('treats the residential robots.txt/KYC refusal as policy too', async () => {
    const impl = vi.fn(async () =>
      refusal('Residential Failed (bad_endpoint): ... in accordance with robots.txt', 'policy_20140'),
    );
    vi.stubGlobal('fetch', impl);

    await expect(retrying().unlocker('https://www.opensanctions.org/search/?q=x')).rejects.toThrow(
      /robots\.txt/,
    );
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
