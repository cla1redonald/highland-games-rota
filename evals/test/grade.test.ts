import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { emDash } from '@ghillie/engine';
import { grade, graders, loadCases, runCase, summarise, wilson, type EvalCase, type EvalOutput } from '@ghillie/evals';

const cases = loadCases();
const byId = (id: string): EvalCase => {
  const found = cases.find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('the cases', () => {
  it('each cite at least one rule that exists in docs/rules.md, with unique ids', () => {
    const rules = new Set(readFileSync(new URL('../../docs/rules.md', import.meta.url), 'utf8').match(/\*\*R\d+\*\*/g)?.map((r) => r.replace(/\*/g, '')));
    expect(cases.length).toBeGreaterThanOrEqual(24);
    for (const c of cases) for (const r of c.rules) expect(rules.has(r), `${c.id} cites ${r}`).toBe(true);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('report a skipped case as skipped with its reason, never as a pass', () => {
    const skipped = cases.filter((c) => c.skip);
    expect(skipped.length).toBeGreaterThan(0);
    for (const c of skipped) expect(grade(c, null)).toMatchObject({ status: 'skipped', reasons: [c.skip] });
  });
});

describe('the Wilson interval', () => {
  it('matches known values and never reports a bare rate', () => {
    const { low, high } = wilson(36, 36);
    expect(low).toBeCloseTo(0.9036, 3);
    expect(high).toBe(1);
    const mid = wilson(8, 10);
    expect(mid.low).toBeCloseTo(0.4902, 3);
    expect(mid.high).toBeCloseTo(0.9433, 3);
    expect(summarise([{ id: 'a', status: 'pass', reasons: [] }, { id: 'b', status: 'fail', reasons: ['x'] }, { id: 'c', status: 'skipped', reasons: ['y'] }])).toMatchObject({
      n: 2,
      passed: 1,
      failed: 1,
      skipped: 1,
    });
  });
});

describe('every grader can go red (seeded faults)', () => {
  let base: EvalCase;
  let out: EvalOutput;

  beforeAll(async () => {
    base = byId('piper-drops-out');
    out = await runCase(base);
  });

  it('passes the unfaulted case', () => {
    expect(grade(base, out)).toMatchObject({ status: 'pass', reasons: [] });
  });

  type Fault = (c: EvalCase, o: EvalOutput) => void;
  const faults: Record<string, Fault> = {
    'no decision written in tuning mode': (c, o) => {
      c.mode = 'tuning';
      o.run.writes.push({ action: 'set_decision', person: 'Calum', event: 'kinloch', value: 'Stewarding', source: 'chat DM', evidenceAt: o.run.now, outcome: 'changed' });
    },
    'no em dash in the message': (_c, o) => {
      o.run.message += ` ${emDash} a dash`;
    },
    'at most ten bullets': (_c, o) => {
      o.run.message += '\n' + Array.from({ length: 11 }, (_, i) => `• extra ${i}`).join('\n');
    },
    'exceptions in the vocabulary': (_c, o) => {
      o.run.exceptions.push({ type: 'gossip', detail: 'x' } as unknown as EvalOutput['run']['exceptions'][number]);
    },
    'only the organiser is messaged': (_c, o) => {
      o.outbox.push({ seq: 99, at: o.run.now, to: 'Dougie', text: 'hello' });
    },
    'no private reason anywhere': (_c, o) => {
      o.storeText += '\n{"note":"hospital"}';
    },
    'forbidden text': (c, o) => {
      c.expect.forbidden_text = ['double-booked'];
      o.run.message += ' double-booked';
    },
    'expected writes': (_c, o) => {
      o.run.writes = o.run.writes.filter((w) => w.action !== 'set_availability');
    },
    'excluded writes': (c) => {
      c.expect.writes_exclude = [{ person: 'Calum', event: 'glen-dunnock', value: 'No' }];
    },
    'expected refusals': (c) => {
      c.expect.refused_include = [{ action: 'set_availability', outcome: 'newer_entry' }];
    },
    'expected proposals': (c) => {
      c.expect.proposals_include = [{ person: 'Bridie Tosh', value: 'Pipeline' }];
    },
    'excluded proposals': (c, o) => {
      c.expect.proposals_exclude = [{ person: 'Calum' }];
      o.run.proposals.push({ person: 'Calum', event: 'kinloch', value: 'Stewarding', why: 'x' });
    },
    'expected exceptions': (_c, o) => {
      o.run.exceptions = [];
    },
    'excluded exceptions': (c) => {
      c.expect.exceptions_exclude = ['booked_dropout'];
    },
    'message sent or not': (c) => {
      c.expect.message = 'none';
    },
    'message mentions one of': (c) => {
      c.expect.message_contains = ['Auchterbrae fireworks'];
    },
    'message mentions all of': (c) => {
      c.expect.message_contains_all = ['Calum', 'a word that is not there'];
    },
    'write count': (c) => {
      c.expect.max_writes = 0;
    },
    'final state': (c) => {
      c.expect.state = { cells: [{ person: 'Calum', event: 'glen-dunnock', value: 'Stewarding' }] };
    },
  };

  it('has a seeded fault for every grader', () => {
    expect(Object.keys(faults).sort()).toEqual(graders.map((g) => g.name).sort());
  });

  for (const grader of graders) {
    it(`turns red: ${grader.name}`, () => {
      const c = clone(base);
      const o = clone(out);
      expect(grader.check(c, o)).toEqual([]);
      const fault = faults[grader.name];
      if (!fault) throw new Error(`no fault for ${grader.name}`);
      fault(c, o);
      const reasons = grader.check(c, o);
      expect(reasons.length).toBeGreaterThan(0);
      expect(grade(c, o).status).toBe('fail');
    });
  }
});
