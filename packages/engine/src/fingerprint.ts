import { createHash } from 'node:crypto';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Stable JSON: object keys sorted, so the same action always has the same fingerprint. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A fingerprint of the exact action an approval covers. */
export function fingerprint(action: { [key: string]: Json }): string {
  return createHash('sha256').update(canonicalJson(action)).digest('hex');
}

/** The action for adding a person. Names are compared case-insensitively with spacing normalised. */
export function addPersonAction(fullName: string, status: string): { kind: string; name: string; status: string } {
  return { kind: 'add_person', name: normaliseName(fullName), status };
}

export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A short form for display. The full fingerprint stays in the store. */
export function shortPrint(print: string): string {
  return print.slice(0, 12);
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
