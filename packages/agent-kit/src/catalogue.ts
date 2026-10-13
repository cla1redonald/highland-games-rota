/**
 * The tool catalogue: the MCP server's own tool list, read once, sorted by name so every request carries the tools in
 * the same order (a reordered tool list is a cache miss).
 *
 * Two schemas per tool. The full one, exactly as the server lists it, is what every call is validated against before
 * it runs. The strict one is what goes to the API with `strict: true`: the same shape with the constraints strict
 * tool use does not accept (lengths, item counts, numeric bounds) removed, tuples turned into arrays, keyed records
 * turned into closed objects and every object closed. The strict copy only ever loosens; the full schema still
 * decides.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Ajv, type ValidateFunction } from 'ajv';

export type JsonSchema = { [key: string]: unknown };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export async function loadCatalogue(client: Client): Promise<ToolSpec[]> {
  const { tools } = await client.listTools();
  return tools
    .map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const droppedKeywords = new Set(['$schema', 'pattern', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'uniqueItems', 'default']);

const isObject = (value: unknown): value is JsonSchema => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The strict-tool-use copy of a schema. Deterministic: the same input always gives the same bytes. */
export function strictSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (droppedKeywords.has(key) || key === 'additionalItems' || key === 'propertyNames') continue;
    if (key === 'oneOf' && Array.isArray(value)) out.anyOf = (value as unknown[]).map((v) => (isObject(v) ? strictSchema(v) : v));
    else if (key === 'items' && Array.isArray(value)) out.items = isObject(value[0]) ? strictSchema(value[0]) : {};
    else if (key === 'properties' && isObject(value)) out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isObject(v) ? strictSchema(v) : v]));
    else if ((key === 'items' || key === 'not') && isObject(value)) out[key] = strictSchema(value);
    else if ((key === 'anyOf' || key === 'allOf') && Array.isArray(value)) out[key] = (value as unknown[]).map((v) => (isObject(v) ? strictSchema(v) : v));
    else if (key === 'additionalProperties') continue;
    else out[key] = value;
  }
  if (schema.type === 'object') {
    const keyed = isObject(schema.propertyNames) && Array.isArray(schema.propertyNames.enum) && isObject(schema.additionalProperties);
    if (keyed) {
      const valueSchema = strictSchema(schema.additionalProperties as JsonSchema);
      out.properties = Object.fromEntries((schema.propertyNames as { enum: string[] }).enum.map((name) => [name, valueSchema]));
    }
    out.properties ??= {};
    out.additionalProperties = false;
  }
  return out;
}

/**
 * Strict tool use compiles every strict schema in a request into one grammar, and refuses a request whose strict
 * schemas have more than this many optional parameters in all (the API's 400 says so). Measured on the first live call.
 */
export const strictOptionalLimit = 24;

/** Optional parameters in a schema, nested objects included. */
export function optionalCount(schema: unknown): number {
  if (!schema || typeof schema !== 'object') return 0;
  const node = schema as JsonSchema;
  let count = 0;
  if (node.type === 'object' && isObject(node.properties)) {
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    count += Object.keys(node.properties).filter((k) => !required.has(k)).length;
  }
  for (const value of Object.values(node)) count += Array.isArray(value) ? (value as unknown[]).reduce((sum: number, v) => sum + optionalCount(v), 0) : optionalCount(value);
  return count;
}

/**
 * Tools sent without strict, measured against the live API (October 2026, Sonnet 5.5): message_organiser alone has 26
 * optional parameters, over the limit; and with the other seven all strict the API refuses the request because "the
 * compiled grammar is too large". Any six of those seven compile. log_run is the one left out: its fields are copied
 * verbatim from the brief. Both are still validated against the server's full schema before they run.
 */
export const nonStrictTools: readonly string[] = ['log_run', 'message_organiser'];

/** Which tools go to the API as strict: all but the measured exceptions, and never past the optional-parameter limit. */
export function strictToolNames(specs: ToolSpec[]): Set<string> {
  const chosen = new Set<string>();
  let total = 0;
  for (const spec of [...specs].sort((a, b) => a.name.localeCompare(b.name))) {
    if (nonStrictTools.includes(spec.name)) continue;
    const n = optionalCount(strictSchema(spec.inputSchema));
    if (total + n > strictOptionalLimit) continue;
    total += n;
    chosen.add(spec.name);
  }
  return chosen;
}

export interface Validation {
  ok: boolean;
  errors: string;
}

/** Validates call arguments against the server's own schemas, the ones that decide. */
export class SchemaValidator {
  private readonly compiled = new Map<string, ValidateFunction>();

  constructor(specs: ToolSpec[]) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    for (const spec of specs) {
      const schema = Object.fromEntries(Object.entries(spec.inputSchema).filter(([key]) => key !== '$schema'));
      this.compiled.set(spec.name, ajv.compile(schema));
    }
  }

  has(name: string): boolean {
    return this.compiled.has(name);
  }

  validate(name: string, input: unknown): Validation {
    const check = this.compiled.get(name);
    if (!check) return { ok: false, errors: `no tool called ${name}` };
    if (check(input)) return { ok: true, errors: '' };
    const errors = (check.errors ?? []).map((e) => `${e.instancePath || '(arguments)'} ${e.message ?? 'is invalid'}${e.params && 'additionalProperty' in e.params ? `: ${String(e.params.additionalProperty)}` : ''}`);
    return { ok: false, errors: errors.slice(0, 6).join('; ') };
  }
}
