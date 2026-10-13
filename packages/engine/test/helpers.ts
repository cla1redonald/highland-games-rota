import { OrganiserConsole, RotaService, Store, config, type Cell, type CellValue, type GamesEvent, type GhillieConfig, type Person } from '@ghillie/engine';

export function person(name: string, fields: Partial<Person> = {}): Person {
  return {
    name,
    surname: 'Test',
    status: 'In',
    role: '',
    email: '',
    note: '',
    risk: '',
    nextStep: '',
    lastChecked: '',
    stewardedBefore: true,
    pronouns: '',
    ...fields,
  };
}

export function games(id: string, date: string, fields: Partial<GamesEvent> = {}): GamesEvent {
  return {
    id,
    label: `${id} Games`,
    type: 'Games',
    village: id,
    date,
    arenas: ['Heavy events field'],
    target: null,
    confirmed: true,
    notes: '',
    ...fields,
  };
}

export function cell(person: string, event: string, value: CellValue, fields: Partial<Cell> = {}): Cell {
  return { person, event, value, note: '', pencilled: false, pencilledAsLead: false, inferred: false, ...fields };
}

export interface TestWorld {
  store: Store;
  service: RotaService;
  console: OrganiserConsole;
  setNow: (iso: string) => void;
}

/** A small world: everything else is added by the test. The clock starts on Monday 7 June 2027 at 13:00. */
export function makeWorld(
  setup: { people?: Person[]; events?: GamesEvent[]; cells?: Cell[]; mode?: 'tuning' | 'full'; config?: GhillieConfig } = {},
): TestWorld {
  const store = new Store({ path: ':memory:' });
  let now = '2027-06-07T13:00:00+01:00';
  const clock = (): Date => new Date(now);
  const settings = setup.config ?? config;
  for (const p of setup.people ?? []) store.insertPerson(p);
  for (const e of setup.events ?? []) store.insertEvent(e);
  for (const c of setup.cells ?? []) store.putCell(c);
  store.setModeRow(setup.mode ?? 'full');
  return {
    store,
    service: new RotaService({ store, clock, config: settings }),
    console: new OrganiserConsole(store, clock, settings),
    setNow: (iso: string) => {
      now = iso;
    },
  };
}

export const said = (at: string, saidBy: string, source = 'chat #stewards'): { source: string; evidenceAt: string; saidBy: string } => ({
  source,
  evidenceAt: at,
  saidBy,
});
