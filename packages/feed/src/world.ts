/**
 * The fictional circuit. Every person, village, address and identifier here is invented.
 *
 * Six Saturday games and a Friday setup day in the summer of 2027. Balvaig Bridge and Inverallt share Saturday
 * 10 July, so the one-place-at-a-time rule bites. Isla organises; Morven, Hamish and Eilidh are the Chief Stewards in
 * that order of preference; Torquil is the partner club's nominee, who can be pencilled as lead but is not a lead for
 * the lost-lead rule.
 */
import {
  OrganiserConsole,
  RotaService,
  Store,
  type Cell,
  type CellValue,
  type GamesEvent,
  type Person,
} from '@ghillie/engine';

const domain = 'example.scot';

function person(name: string, surname: string, fields: Partial<Person>): Person {
  return {
    name,
    surname,
    status: 'In',
    role: 'Steward',
    email: `${name.toLowerCase()}.${surname.toLowerCase()}@${domain}`,
    note: '',
    risk: '',
    nextStep: '',
    lastChecked: '',
    stewardedBefore: true,
    pronouns: '',
    ...fields,
  };
}

export const people: Person[] = [
  person('Morven', 'Lennie', { role: 'Chief Steward', pronouns: 'she/her' }),
  person('Hamish', 'Baird', { role: 'Chief Steward', pronouns: 'he/him' }),
  person('Eilidh', 'Rennie', { role: 'Chief Steward' }),
  person('Torquil', 'Mair', { role: 'Partner club nominee (Strathcorrie Shinty Club)' }),
  person('Fergus', 'Duthie', { role: 'Steward, twenty summers of it' }),
  person('Ailsa', 'Kerr', {}),
  person('Dougie', 'Lamont', { role: 'Tug-of-war marshal' }),
  person('Calum', 'Rattray', { role: 'Piper and steward', status: 'Maybe', risk: 'Has said he might stop, on and off, since March' }),
  person('Senga', 'Morton', { role: 'Announcer' }),
  person('Kirsty', 'Imrie', { role: 'Steward (first season)', status: 'Maybe', stewardedBefore: false }),
  person('Gregor', 'Pirie', {}),
  person('Netta', 'Bain', {}),
  person('Lachlan', 'Gow', { status: 'Maybe' }),
  person('Struan', 'Ogilvie', { role: 'Committee treasurer', status: 'Leadership', stewardedBefore: false }),
  person('Ruaridh', 'Gunn', {
    role: '',
    status: 'Pipeline',
    stewardedBefore: false,
    note: "Kirsty's cousin; offered to help (committee meeting, May)",
    nextStep: 'Isla to decide whether to ask Ruaridh for dates',
  }),
  person('Morag', 'Sim', { status: 'Out', nextStep: 'Revisit next season' }),
  person('Isla', 'Munro', { role: 'Organiser', status: 'Leadership', pronouns: 'she/her' }),
];

const heavy = 'Heavy events field';
const track = 'Track and field';
const piping = 'Piping and dancing platform';
const tug = 'Tug-of-war pitch';
const children = "Children's races";

export const events: GamesEvent[] = [
  { id: 'setup-day', label: 'Circuit setup day', type: 'Setup day', village: 'Glen Dunnock', date: '2027-06-25', arenas: [], target: null, confirmed: true, notes: '' },
  { id: 'glen-dunnock', label: 'Glen Dunnock Games', type: 'Games', village: 'Glen Dunnock', date: '2027-06-26', arenas: [heavy, track, tug], target: null, confirmed: true, notes: '' },
  { id: 'kinloch', label: 'Kinloch-on-Spey Games', type: 'Games', village: 'Kinloch-on-Spey', date: '2027-07-03', arenas: [heavy, piping], target: null, confirmed: true, notes: '' },
  { id: 'balvaig', label: 'Balvaig Bridge Games', type: 'Games', village: 'Balvaig Bridge', date: '2027-07-10', arenas: [heavy, children], target: null, confirmed: true, notes: '' },
  { id: 'inverallt', label: 'Inverallt Games', type: 'Games', village: 'Inverallt', date: '2027-07-10', arenas: [piping, tug], target: null, confirmed: true, notes: '' },
  { id: 'strathcorrie', label: 'Strathcorrie Games', type: 'Games', village: 'Strathcorrie', date: '2027-07-17', arenas: [heavy, track, children], target: null, confirmed: true, notes: '' },
  {
    id: 'auchterbrae',
    label: 'Auchterbrae Games',
    type: 'Games',
    village: 'Auchterbrae',
    date: '2027-07-31',
    arenas: [heavy, piping, tug],
    target: 4,
    confirmed: false,
    notes: 'Target 4, not 6: small field this year (Isla, May)',
  },
];

type SeedCell = CellValue | { value: CellValue; pencilled?: boolean; asLead?: boolean; note?: string; inferred?: boolean };

/** The rota as it stood on Friday 4 June 2027, before the fortnight. Blank means not asked. */
const seedGrid: Record<string, Record<string, SeedCell>> = {
  Morven: { 'glen-dunnock': { value: 'Yes', pencilled: true, asLead: true }, kinloch: { value: 'Yes', pencilled: true, asLead: true }, balvaig: 'No', inverallt: 'No', strathcorrie: 'Yes', auchterbrae: 'Unknown' },
  Hamish: { 'setup-day': 'Yes', 'glen-dunnock': 'Yes', kinloch: 'Yes', balvaig: 'Yes', inverallt: 'Maybe', strathcorrie: 'Maybe', auchterbrae: 'Yes' },
  Eilidh: { 'glen-dunnock': 'No', kinloch: 'Yes', balvaig: { value: 'Yes', pencilled: true, asLead: true }, inverallt: 'Yes', strathcorrie: 'Yes', auchterbrae: 'Yes' },
  Torquil: { balvaig: 'Yes', inverallt: { value: 'Yes', pencilled: true, asLead: true }, strathcorrie: 'Yes', auchterbrae: { value: 'Yes', inferred: true, note: 'Not asked about Auchterbrae: inferred from his dates for the others' } },
  Fergus: { 'setup-day': 'Yes', 'glen-dunnock': 'Yes', kinloch: 'Yes', strathcorrie: 'Unknown', auchterbrae: 'Yes' },
  Ailsa: { 'glen-dunnock': 'Yes', kinloch: 'Maybe' },
  Dougie: { 'setup-day': 'Yes', 'glen-dunnock': 'Yes', inverallt: 'Yes', strathcorrie: 'Yes', auchterbrae: 'Maybe' },
  Calum: { 'glen-dunnock': 'Stewarding', kinloch: 'Yes', balvaig: 'No', inverallt: 'Yes', auchterbrae: 'Yes' },
  Senga: { 'glen-dunnock': 'Yes', kinloch: 'Unknown', strathcorrie: 'Yes' },
  Kirsty: { 'glen-dunnock': 'Yes', kinloch: { value: 'Maybe', note: 'Pending a call with Isla on Wed 9 Jun' } },
  Netta: { 'glen-dunnock': 'Unknown', strathcorrie: 'Yes' },
  Lachlan: { auchterbrae: 'Yes' },
};

export function seedCells(): Cell[] {
  const cells: Cell[] = [];
  for (const [name, row] of Object.entries(seedGrid)) {
    for (const [event, seed] of Object.entries(row)) {
      const cell = typeof seed === 'string' ? { value: seed } : seed;
      cells.push({
        person: name,
        event,
        value: cell.value,
        note: cell.note ?? '',
        pencilled: cell.pencilled ?? false,
        pencilledAsLead: cell.asLead ?? false,
        inferred: cell.inferred ?? false,
      });
    }
  }
  return cells;
}

/** The previous run, logged on the Friday evening before the fortnight, so the first tick has a window to anchor on. */
export const seedRun = { from: '2027-06-04T13:00:00+01:00', to: '2027-06-04T18:00:00+01:00', loggedAt: '2027-06-04T18:04:00+01:00' };

/** Answers given before the seed run, dated so the newer-entry guard has history to compare against. */
const seedEvidenceAt = '2027-05-20T19:30:00+01:00';

export const sourceNames = ['chat', 'mail', 'minutes', 'calendar'] as const;

/**
 * Builds the world into an empty store: people, events, the seeded rota with its history, full mode, and a
 * previous run summary. Returns the service and console bound to a clock the caller controls.
 */
export function seedWorld(store: Store, clock: () => Date, options: { mode?: 'tuning' | 'full' } = {}): { service: RotaService; console: OrganiserConsole } {
  const service = new RotaService({ store, clock });
  const organiser = new OrganiserConsole(store, clock);
  store.transaction(() => {
    for (const p of people) store.insertPerson(p);
    for (const e of events) store.insertEvent(e);
    for (const cell of seedCells()) {
      store.putCell(cell);
      if (cell.value) {
        store.appendLog({
          writtenAt: seedEvidenceAt,
          who: 'seed',
          saidBy: cell.value === 'Stewarding' ? 'Isla' : cell.person,
          entity: 'cell',
          key: `${cell.person}::${cell.event}`,
          field: 'value',
          old: '',
          new: cell.value,
          source: 'committee meeting',
          evidenceAt: seedEvidenceAt,
        });
      }
    }
    store.setModeRow(options.mode ?? 'full');
  });
  return { service, console: organiser };
}

/** Logs the seed run, as a run on Friday 4 June would have. The service works out the snapshot itself. */
export function logSeedRun(service: RotaService): void {
  const result = service.logRun({
    window: [seedRun.from, seedRun.to],
    sources: Object.fromEntries(sourceNames.map((s) => [s, 'ok'])),
    sourceWindows: Object.fromEntries(sourceNames.map((s) => [s, [seedRun.from, seedRun.to]])),
    exceptions: 0,
    read: [],
    toolCalls: 0,
  });
  if (!result.ok) throw new Error(`seed run refused: ${result.detail}`);
}
