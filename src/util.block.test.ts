import { describe, it, expect } from 'vitest';
import { assertUnblocked, BlockedError } from './util.js';

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
