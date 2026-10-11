import { describe, it, expect } from 'vitest';
import { assertUnblocked, BlockedError, parseSerp } from './util.js';

const big = (body: string) => body + 'x'.repeat(200_000);

describe('a real page is not a challenge just because it mentions one', () => {
  it('accepts a large page containing the word captcha', () => {
    // The regression this exists for: a 581KB Goodyear homepage titled
    // "Shop For Tires Online" was discarded because one script referenced
    // reCAPTCHA. That cost the data and the credit spent fetching it.
    expect(() => assertUnblocked(big(
      '<html><head><title>Shop For Tires Online | Goodyear</title></head>' +
      '<body><form data-recaptcha="true">captcha</form>',
    ))).not.toThrow();
  });

  it('accepts a large page served via Cloudflare', () => {
    expect(() => assertUnblocked(big(
      '<html><head><title>Careers | Example Corp</title>' +
      '<script src="https://cdnjs.cloudflare.com/x.js"></script></head><body>',
    ))).not.toThrow();
  });

  it('accepts a support page that discusses "access denied"', () => {
    expect(() => assertUnblocked(big(
      '<html><head><title>Help centre</title></head><body>If you see access denied, try…',
    ))).not.toThrow();
  });
});

describe('an actual challenge page is still caught', () => {
  it('catches a strong marker anywhere, regardless of size', () => {
    expect(() => assertUnblocked(big('<html><body><div id="cf-chl-widget">'))).toThrow(BlockedError);
  });

  it('catches it by title', () => {
    expect(() => assertUnblocked(big('<html><head><title>Just a moment...</title></head>')))
      .toThrow(/title/);
  });

  it('catches a weak marker on a SMALL page -- the word plus the shape', () => {
    expect(() => assertUnblocked('<html><head><title>x</title></head><body>captcha required</body>'))
      .toThrow(/captcha on a \d+-byte page/);
  });

  it('catches Cloudflare interstitials, which are small', () => {
    expect(() => assertUnblocked('<html><body>Attention Required! Cloudflare</body>'))
      .toThrow(BlockedError);
  });

  it('still rejects an empty body', () => {
    expect(() => assertUnblocked('   ')).toThrow(/empty body/);
  });
});

/**
 * The 36KB homepage. Sixteen consecutive `domain` runs failed with
 * "captcha on a 36303-byte page" while CHALLENGE_MAX_BYTES was 40_000: an
 * ordinary homepage that references reCAPTCHA in a script, sitting just under
 * the corroboration ceiling. The source read as blocked for a day, which is
 * worse than a gap -- it is a gap that looks like a finding.
 */
describe('a real homepage near the old ceiling is not a challenge page', () => {
  const homepage = (bytes: number) =>
    '<html><head><title>Shop For Tires Online</title></head><body>' +
    '<script src="https://www.google.com/recaptcha/api.js"></script>' +
    'x'.repeat(bytes) +
    '</body></html>';

  for (const bytes of [12_000, 20_000, 36_303, 37_424]) {
    it(`accepts a ${bytes}-byte homepage that merely mentions recaptcha`, () => {
      expect(() => assertUnblocked(homepage(bytes))).not.toThrow();
    });
  }

  it('still corroborates a weak marker on a genuinely small interstitial', () => {
    expect(() => assertUnblocked('<html><body>captcha</body></html>'))
      .toThrow(/captcha on a \d+-byte page/);
  });
});

describe('parseSerp says what it actually received', () => {
  it('reports an empty body as a refusal or timeout, not a parse problem', () => {
    expect(() => parseSerp('')).toThrow(/empty body -- a refusal or a timeout/);
  });

  it('quotes the beginning of a non-JSON body, so the cause is in the record', () => {
    expect(() => parseSerp('<html><body>Gateway Timeout</body></html>'))
      .toThrow(/Gateway Timeout/);
  });

  it('still parses the JSON the SERP zone actually returns', () => {
    const body = JSON.stringify({
      general: { search_engine: 'google' },
      organic: [{ title: 'Cardinal Health names CFO', link: 'https://example.com/a', rank: 1 }],
    });
    expect(parseSerp(body)).toHaveLength(1);
  });
});
