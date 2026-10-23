/**
 * Live ticks spend the owner's API key, so they sit behind a password. The right password sets a signed cookie that
 * unlocks live ticks in that browser for a week. Replays and the stand-in need nothing: they are free.
 *
 * Every write also has to come from the page itself: JSON, and from this site's own origin.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const cookieName = 'ghillie_live';
export const cookieMaxAge = 7 * 24 * 60 * 60;

const password = (): string | undefined => process.env.LIVE_PASSWORD?.trim() || undefined;

const secret = (): string | undefined => process.env.LIVE_COOKIE_SECRET?.trim() || password();

const same = (a: string, b: string): boolean => {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};

/** The cookie's value: a signature over a version tag, so changing the password or the secret locks every browser. */
export function token(): string | null {
  const key = secret();
  const pw = password();
  return key && pw ? createHmac('sha256', key).update(`live-v1:${createHash('sha256').update(pw).digest('hex')}`).digest('base64url') : null;
}

export function passwordSet(): boolean {
  return Boolean(password());
}

export function checkPassword(given: string): boolean {
  const pw = password();
  return Boolean(pw) && same(given, pw ?? '');
}

export function unlocked(cookie: string | undefined): boolean {
  const expected = token();
  return Boolean(expected && cookie && same(cookie, expected ?? ''));
}

/** A POST the page made: JSON, and from this origin. A cross-site form or fetch cannot send JSON without a preflight. */
export function fromThisPage(req: Request): boolean {
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return false;
  const origin = req.headers.get('origin');
  return origin === null || origin === new URL(req.url).origin;
}
