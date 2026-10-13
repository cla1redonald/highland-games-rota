/**
 * Fail-closed text checks. Medical and family reasons never appear anywhere, not even in the message to the organiser.
 * Money stays out of the rota (the message may name a money or travel condition). Nothing that looks like a secret is
 * ever written or sent.
 */

const medicalOrFamily: RegExp[] = [
  /\bgall ?bladder\b/i,
  /\bop\b/i,
  /\boperation\b/i,
  /\bsurgery\b/i,
  /\bhospital\b/i,
  /\bclinic\b/i,
  /\bdoctor\b/i,
  /\bconsultant\b/i,
  /\bmedical\b/i,
  /\bappointment\b/i,
  /\billness\b/i,
  /\bsick\b/i,
  /\bfuneral\b/i,
  /\bpregnan\w*/i,
  /\bmum\b/i,
  /\bmother\b/i,
  /\bdad\b/i,
  /\bfather\b/i,
  /\bdivorce\w*/i,
  /\bcare home\b/i,
  /\brecover\w*/i,
];

const money: RegExp[] = [/£\s?\d/, /\bexpenses\b/i, /\bfee\b/i, /\bpaid\b/i, /\bpetrol money\b/i];

const secrets: RegExp[] = [/\bsk-[A-Za-z0-9_-]{16,}/, /\b(api[_-]?key|access[_-]?key|token|secret)\s*[:=]\s*\S{8,}/i];

export type TextCheck = { ok: true } | { ok: false; reason: 'private_detail' | 'secret_detected'; match: string };

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found) return found[0];
  }
  return null;
}

/** For anything written to the rota: notes, next steps, risks. */
export function checkRotaText(text: string): TextCheck {
  const secret = firstMatch(text, secrets);
  if (secret) return { ok: false, reason: 'secret_detected', match: '[redacted]' };
  const personal = firstMatch(text, [...medicalOrFamily, ...money]);
  if (personal) return { ok: false, reason: 'private_detail', match: personal };
  return { ok: true };
}

/** For the message to the organiser: a money or travel condition may be named, a medical or family reason may not. */
export function checkMessageText(text: string): TextCheck {
  const secret = firstMatch(text, secrets);
  if (secret) return { ok: false, reason: 'secret_detected', match: '[redacted]' };
  const personal = firstMatch(text, medicalOrFamily);
  if (personal) return { ok: false, reason: 'private_detail', match: personal };
  return { ok: true };
}

/** The em dash, built from its code point so this file does not contain one. */
export const emDash = String.fromCharCode(0x2014);

export function countBullets(text: string): number {
  return text.split('\n').filter((line) => /^\s*(?:•|-|\*|\d+[.)])\s+/.test(line)).length;
}
