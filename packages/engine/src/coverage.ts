/**
 * Coverage and the suggested split.
 *
 * Staff the Saturday, not the game: games on the same Saturday run at the same time, so each person is placed at one
 * game that day and counted once. The split is a suggestion, never a booking.
 *
 * Placement order on each Saturday:
 *   1. bookings (Stewarding, Supporting) stay where they are;
 *   2. the organiser's pencilled people, at one game each;
 *   3. Yes people, filling the emptiest game first (relative to its target), with anyone who would reach the
 *      over-use limit after everyone else, then Chief Stewards last in preference order, then fewest weeks running;
 *      a person who can only make one game is never crowded out of it (augmenting paths move people, never drop them);
 *   4. anyone left over is a spare, listed once, at the first game they said Yes to;
 *   5. Maybes fill the remaining gaps the same way.
 */
import { config, type RuleConfig, type RoleConfig } from './config.js';
import { daysBetween, weeksAway } from './dates.js';
import { onBenchStatuses, onSiteDecisions, type Cell, type CellValue, type GamesEvent, type Person } from './types.js';

export type Rag = 'Green' | 'Amber' | 'Red';

export interface PlanSettings {
  rules: Pick<RuleConfig, 'stewardsPerArena' | 'overUsedFrom' | 'lookaheadWeeks'>;
  roles: Pick<RoleConfig, 'chiefStewards' | 'partnerNominees'>;
}

export const defaultPlanSettings: PlanSettings = { rules: config.rules, roles: config.roles };

export interface OverUse {
  person: string;
  /** Calendar weeks running, this one included. */
  weeks: number;
}

export interface GamesPlan {
  id: string;
  label: string;
  date: string;
  weeksAway: number;
  target: number;
  booked: string[];
  supporting: string[];
  pencilled: string[];
  /** Placed by the split, pencilled first. */
  placed: string[];
  spare: string[];
  /** Spares elsewhere that Saturday who said Yes here too. */
  cover: string[];
  maybes: string[];
  counted: number;
  deltaNow: number;
  deltaMaybe: number;
  rag: Rag;
  problems: string;
  /** A Chief Steward booked, supporting or pencilled here, in preference order. Placed-by-split does not count. */
  lead: string | null;
  /** A partner nominee pencilled as lead: shown, but not a lead for the lost-lead rule. */
  partnerLead: string | null;
  overUsed: OverUse[];
  doubleBooked: { person: string; at: string; value: string }[];
  pencilledTwice: { person: string; placedAt: string }[];
  newcomers: string[];
}

export interface SaturdayPlan {
  date: string;
  weeksAway: number;
  games: string[];
  need: number;
  stewarding: number;
  /** Each person once across the day's games. */
  counted: number;
  maybe: number;
  deltaNow: number;
  deltaMaybe: number;
  rag: Rag;
  doubleBooked: string[];
  countedPeople: string[];
  noSpare: boolean;
}

export interface ChaseItem {
  person: string;
  event: string;
  value: CellValue;
  /** A Maybe left pending a call: revisit it once the call has happened. */
  pendingCall: boolean;
}

export interface RotaPlan {
  today: string;
  games: GamesPlan[];
  saturdays: SaturdayPlan[];
  chase: ChaseItem[];
}

export function targetOf(event: GamesEvent, stewardsPerArena: number): number {
  if (event.target !== null && Number.isFinite(event.target)) return event.target;
  return event.arenas.length * stewardsPerArena;
}

export function ragOf(deltaNow: number, deltaMaybe: number): Rag {
  if (deltaNow >= 0) return 'Green';
  if (deltaMaybe >= 0) return 'Amber';
  return 'Red';
}

/** Games that count towards coverage: dated games, not superseded, not finished. */
export function activeGames(events: GamesEvent[], today: string): GamesEvent[] {
  return events
    .filter((event) => event.type === 'Games' && event.date && daysBetween(today, event.date) >= 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

interface Slot {
  event: GamesEvent;
  target: number;
  booked: string[];
  supporting: string[];
  pencilled: string[];
  pencilledTwice: { person: string; placedAt: string }[];
  placed: string[];
  spare: string[];
  cover: string[];
  maybeFill: string[];
  maybeSpare: string[];
}

type SlotList = 'placed' | 'maybeFill';

export function planRota(
  people: Person[],
  events: GamesEvent[],
  cells: Cell[],
  today: string,
  settings: PlanSettings = defaultPlanSettings,
): RotaPlan {
  const { rules, roles } = settings;
  const bench = people.filter((p) => onBenchStatuses.includes(p.status)).map((p) => p.name);
  const order = new Map(bench.map((name, i) => [name, i]));
  const cellMap = new Map(cells.map((c) => [`${c.person}::${c.event}`, c]));
  const cellOf = (person: string, event: string): Cell | undefined => cellMap.get(`${person}::${event}`);
  const valueOf = (person: string, event: string): CellValue => cellOf(person, event)?.value ?? '';
  const isPencilled = (person: string, event: string): boolean => {
    const cell = cellOf(person, event);
    return !!cell && cell.pencilled && cell.value === 'Yes';
  };

  const games = activeGames(events, today);
  const dates = [...new Set(games.map((g) => g.date))].sort();
  const slotsByDate = new Map<string, Slot[]>();
  for (const event of games) {
    const slot: Slot = {
      event,
      target: targetOf(event, rules.stewardsPerArena),
      booked: [],
      supporting: [],
      pencilled: [],
      pencilledTwice: [],
      placed: [],
      spare: [],
      cover: [],
      maybeFill: [],
      maybeSpare: [],
    };
    const list = slotsByDate.get(event.date) ?? [];
    list.push(slot);
    slotsByDate.set(event.date, list);
  }

  const goingOn = new Map<string, Set<string>>();
  const isGoing = (person: string, date: string): boolean => goingOn.get(date)?.has(person) ?? false;
  const consecutive = (earlier: string, later: string): boolean => daysBetween(earlier, later) === 7;

  // Weeks running at index i: this Saturday plus each calendar week straight before it where the person is going
  // (booked, supporting, pencilled or placed). A Yes alone is not going. A week off, with or without games, resets it.
  const weeksRunning = (person: string, i: number): number => {
    let n = 1;
    for (let k = i - 1; k >= 0; k--) {
      const later = dates[k + 1];
      const earlier = dates[k];
      if (!later || !earlier || !consecutive(earlier, later) || !isGoing(person, earlier)) break;
      n++;
    }
    return n;
  };
  const committedOn = (person: string, date: string): boolean =>
    (slotsByDate.get(date) ?? []).some((slot) => {
      const value = valueOf(person, slot.event.id);
      return (onSiteDecisions as readonly string[]).includes(value) || isPencilled(person, slot.event.id);
    });
  // Looking back is not enough: a booking in the weeks straight after this one counts too, or the split would fill the
  // middle Saturday between two bookings.
  const weeksAhead = (person: string, i: number): number => {
    let n = 0;
    for (let k = i + 1; k < dates.length; k++) {
      const earlier = dates[k - 1];
      const later = dates[k];
      if (!earlier || !later || !consecutive(earlier, later) || !committedOn(person, later)) break;
      n++;
    }
    return n;
  };

  dates.forEach((date, i) => {
    const slots = slotsByDate.get(date) ?? [];
    const taken = new Set<string>();

    for (const person of bench) {
      for (const slot of slots) {
        const value = valueOf(person, slot.event.id);
        if (value === 'Stewarding') {
          slot.booked.push(person);
          taken.add(person);
        }
        if (value === 'Supporting') {
          slot.supporting.push(person);
          taken.add(person);
        }
      }
    }

    for (const person of bench) {
      if (taken.has(person)) continue;
      const pencilledAt = slots.filter((slot) => isPencilled(person, slot.event.id));
      const first = pencilledAt[0];
      if (!first) continue;
      first.pencilled.push(person);
      taken.add(person);
      for (const other of pencilledAt.slice(1)) other.pencilledTwice.push({ person, placedAt: first.event.label });
    }

    const tired = (person: string): number => (weeksRunning(person, i) + weeksAhead(person, i) >= rules.overUsedFrom ? 1 : 0);
    const leadRank = (person: string): number => roles.chiefStewards.indexOf(person) + 1;
    const byPriority = (a: string, b: string): number =>
      tired(a) - tired(b) ||
      leadRank(a) - leadRank(b) ||
      weeksRunning(a, i) - weeksRunning(b, i) ||
      (order.get(a) ?? 0) - (order.get(b) ?? 0);

    const place = (pool: string[], status: 'Yes' | 'Maybe', list: SlotList, room: (slot: Slot) => number): string[] => {
      const unplaced: string[] = [];
      for (const person of pool) {
        const visited = new Set<string>();
        const augment = (who: string): boolean => {
          const free = (slot: Slot): number => room(slot) - slot[list].length;
          const share = (slot: Slot): number => (slot.target ? free(slot) / slot.target : 0);
          const options = slots
            .filter((slot) => valueOf(who, slot.event.id) === status)
            .sort((a, b) => share(b) - share(a) || free(b) - free(a) || slots.indexOf(a) - slots.indexOf(b));
          for (const slot of options) {
            if (visited.has(slot.event.id)) continue;
            visited.add(slot.event.id);
            if (slot[list].length < room(slot)) {
              slot[list].push(who);
              return true;
            }
            // Full: try to move someone already here to another game they said the same to, freeing this place.
            for (let k = 0; k < slot[list].length; k++) {
              const occupant = slot[list][k];
              if (occupant !== undefined && augment(occupant)) {
                slot[list][k] = who;
                return true;
              }
            }
          }
          return false;
        };
        if (!augment(person)) unplaced.push(person);
      }
      return unplaced;
    };

    const yesPool = bench
      .filter((p) => !taken.has(p) && slots.some((slot) => valueOf(p, slot.event.id) === 'Yes'))
      .sort(byPriority);
    const leftOver = place(yesPool, 'Yes', 'placed', (slot) => Math.max(0, slot.target - slot.booked.length - slot.pencilled.length));
    for (const slot of slots) slot.placed = [...slot.pencilled, ...slot.placed];
    for (const person of leftOver) {
      const options = slots.filter((slot) => valueOf(person, slot.event.id) === 'Yes');
      options[0]?.spare.push(person);
      for (const slot of options) slot.cover.push(person);
    }

    const placedNow = new Set(slots.flatMap((slot) => [...slot.placed, ...slot.spare]));
    const maybePool = bench
      .filter((p) => !taken.has(p) && !placedNow.has(p) && slots.some((slot) => valueOf(p, slot.event.id) === 'Maybe'))
      .sort(byPriority);
    const maybeLeft = place(maybePool, 'Maybe', 'maybeFill', (slot) =>
      Math.max(0, slot.target - slot.booked.length - slot.placed.length),
    );
    for (const person of maybeLeft) {
      slots.find((slot) => valueOf(person, slot.event.id) === 'Maybe')?.maybeSpare.push(person);
    }

    goingOn.set(date, new Set(slots.flatMap((slot) => [...slot.booked, ...slot.supporting, ...slot.placed])));
  });

  const byOrder = (names: string[]): string[] => [...names].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const seenCounted = new Set<string>(people.filter((p) => p.stewardedBefore).map((p) => p.name));
  const gamesPlans: GamesPlan[] = [];

  dates.forEach((date, i) => {
    const slots = slotsByDate.get(date) ?? [];
    const newThisDay: string[][] = [];
    for (const slot of slots) {
      const going = byOrder([...slot.booked, ...slot.placed]);
      newThisDay.push(going.filter((p) => !seenCounted.has(p)));
    }
    slots.forEach((slot, s) => {
      const counted = slot.booked.length + slot.placed.length + slot.spare.length;
      const deltaNow = counted - slot.target;
      const maybes = byOrder([...slot.maybeFill, ...slot.maybeSpare]);
      const deltaMaybe = deltaNow + maybes.length;
      const doubleBooked: GamesPlan['doubleBooked'] = [];
      for (const person of [...slot.booked, ...slot.supporting]) {
        for (const other of slots) {
          if (other === slot) continue;
          const value = valueOf(person, other.event.id);
          if ((onSiteDecisions as readonly string[]).includes(value)) doubleBooked.push({ person, at: other.event.label, value });
        }
      }
      const overUsed = byOrder([...slot.booked, ...slot.supporting, ...slot.placed])
        .map((person) => ({ person, weeks: weeksRunning(person, i) }))
        .filter((entry) => entry.weeks >= rules.overUsedFrom);
      const firmLeads = roles.chiefStewards.filter(
        (lead) =>
          slot.booked.includes(lead) ||
          slot.supporting.includes(lead) ||
          slot.pencilled.includes(lead) ||
          (cellOf(lead, slot.event.id)?.pencilledAsLead === true && valueOf(lead, slot.event.id) === 'Yes'),
      );
      const partnerLead =
        roles.partnerNominees.find((name) => cellOf(name, slot.event.id)?.pencilledAsLead === true && valueOf(name, slot.event.id) === 'Yes') ??
        null;
      const plan: GamesPlan = {
        id: slot.event.id,
        label: slot.event.label,
        date,
        weeksAway: weeksAway(date, today),
        target: slot.target,
        booked: byOrder(slot.booked),
        supporting: byOrder(slot.supporting),
        pencilled: byOrder(slot.pencilled),
        placed: slot.placed,
        spare: byOrder(slot.spare),
        cover: byOrder(slot.cover),
        maybes,
        counted,
        deltaNow,
        deltaMaybe,
        rag: ragOf(deltaNow, deltaMaybe),
        problems: '',
        lead: firmLeads[0] ?? null,
        partnerLead,
        overUsed,
        doubleBooked,
        pencilledTwice: slot.pencilledTwice,
        newcomers: newThisDay[s] ?? [],
      };
      plan.problems = problemText(plan);
      gamesPlans.push(plan);
    });
    for (const slot of slots) for (const person of [...slot.booked, ...slot.placed]) seenCounted.add(person);
  });

  const saturdays: SaturdayPlan[] = dates.map((date) => {
    const slots = slotsByDate.get(date) ?? [];
    const ids = slots.map((slot) => slot.event.id);
    const need = slots.reduce((sum, slot) => sum + slot.target, 0);
    const counts = (person: string, wanted: string[]): number =>
      ids.filter((id) => wanted.includes(valueOf(person, id))).length;
    const countedPeople = bench.filter((p) => counts(p, ['Stewarding', 'Yes']) > 0);
    const maybePeople = bench.filter((p) => counts(p, ['Maybe']) > 0 && counts(p, ['Stewarding', 'Yes']) === 0);
    const stewarding = bench.filter((p) => counts(p, ['Stewarding']) > 0).length;
    const doubleBooked = bench.filter((p) => counts(p, ['Stewarding', 'Supporting']) >= 2);
    const deltaNow = countedPeople.length - need;
    const deltaMaybe = deltaNow + maybePeople.length;
    return {
      date,
      weeksAway: weeksAway(date, today),
      games: ids,
      need,
      stewarding,
      counted: countedPeople.length,
      maybe: maybePeople.length,
      deltaNow,
      deltaMaybe,
      rag: ragOf(deltaNow, deltaMaybe),
      doubleBooked,
      countedPeople,
      noSpare: deltaNow === 0,
    };
  });

  const chase: ChaseItem[] = [];
  for (const game of games) {
    if (weeksAway(game.date, today) > rules.lookaheadWeeks) continue;
    for (const person of bench) {
      const cell = cellOf(person, game.id);
      const value = cell?.value ?? '';
      if (value === 'Maybe' || value === 'Unknown' || value === '') {
        chase.push({ person, event: game.id, value, pendingCall: /^pending a call/i.test(cell?.note ?? '') });
      }
    }
  }

  return { today, games: gamesPlans, saturdays, chase };
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** Only what is wrong with the game. Who is going is shown beside it in the plan. */
export function problemText(plan: GamesPlan): string {
  const parts: string[] = [];
  if (plan.deltaNow < 0) {
    parts.push(`Short ${-plan.deltaNow} of ${plan.target}.`);
    if (plan.deltaMaybe < 0) {
      parts.push(`Short even if every Maybe says yes${plan.maybes.length ? ` (${plan.maybes.join(', ')})` : ''}.`);
    } else {
      parts.push(`Maybes who could fill it: ${plan.maybes.join(', ')}.`);
    }
  } else if (plan.deltaNow === 0 && plan.cover.length === 0) {
    parts.push('No spare: anyone dropping out makes it short.');
  }
  if (plan.doubleBooked.length) {
    parts.push(`Double-booked: ${plan.doubleBooked.map((d) => `${d.person} also ${d.value.toLowerCase()} at ${d.at}`).join('; ')}.`);
  }
  if (plan.pencilledTwice.length) {
    parts.push(`Pencilled twice this Saturday: ${plan.pencilledTwice.map((p) => `${p.person} (placed at ${p.placedAt})`).join(', ')}.`);
  }
  if (plan.overUsed.length) {
    parts.push(`Over-used: ${plan.overUsed.map((o) => `${o.person} (${ordinal(o.weeks)} Saturday running)`).join(', ')}.`);
  }
  return parts.join(' ');
}

export { ordinal };
