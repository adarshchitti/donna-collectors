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
