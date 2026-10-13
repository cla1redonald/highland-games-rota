/**
 * The Plan, the view the organiser reads: one block per Saturday (need, short or spare), then each game on it:
 * target, short or spare, what is wrong, the lead, then one person per place.
 */
import type { GamesPlan, RotaPlan, SaturdayPlan } from './coverage.js';
import { formatDay } from './dates.js';

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

interface Place {
  name: string;
  kind: 'stewarding' | 'pencilled' | 'suggested' | 'short' | 'beyond';
  isNew: boolean;
}

/** One entry per place up to the target: booked, then pencilled, then suggested, then Short. */
export function placesOf(game: GamesPlan): Place[] {
  const places: Place[] = [];
  const isNew = (name: string): boolean => game.newcomers.includes(name);
  for (const name of game.booked) places.push({ name, kind: 'stewarding', isNew: isNew(name) });
  for (const name of game.pencilled) places.push({ name, kind: 'pencilled', isNew: isNew(name) });
  for (const name of game.placed.filter((p) => !game.pencilled.includes(p))) places.push({ name, kind: 'suggested', isNew: isNew(name) });
  while (places.length < game.target) places.push({ name: 'Short', kind: 'short', isNew: false });
  return places.map((place, i) => (i >= game.target && place.kind !== 'short' ? { ...place, kind: 'beyond' } : place));
}

function placeText(place: Place): string {
  if (place.kind === 'short') return 'Short';
  const tags = [place.kind === 'suggested' ? '' : place.kind, place.isNew ? 'new' : ''].filter(Boolean);
  return tags.length ? `${place.name} (${tags.join(', ')})` : place.name;
}

function leadText(game: GamesPlan): string {
  if (game.lead) return game.lead;
  if (game.partnerLead) return `none (${game.partnerLead} pencilled as lead: partner nominee, not counted as a lead)`;
  return 'none';
}

export function renderPlanText(plan: RotaPlan, title = 'Plan'): string {
  const lines: string[] = [`${title} (as at ${formatDay(plan.today)})`];
  for (const saturday of plan.saturdays) {
    lines.push('');
    lines.push(
      `${formatDay(saturday.date)}  need ${saturday.need}  counted ${saturday.counted}  maybe ${saturday.maybe}  ${signed(saturday.deltaNow)}  ${saturday.rag}` +
        (saturday.games.length > 1 ? '  (each person counted once across the day)' : ''),
    );
    for (const game of plan.games.filter((g) => g.date === saturday.date)) {
      lines.push(`  ${game.label}  target ${game.target}  ${signed(game.deltaNow)}  ${game.rag}  Lead: ${leadText(game)}`);
      if (game.problems) lines.push(`    Problem: ${game.problems}`);
      lines.push(`    Places: ${placesOf(game).map(placeText).join(' | ')}`);
      const extras = [
        game.supporting.length ? `Supporting: ${game.supporting.join(', ')}` : '',
        game.spare.length ? `Spare: ${game.spare.join(', ')}` : '',
        game.maybes.length ? `Maybe: ${game.maybes.join(', ')}` : '',
      ].filter(Boolean);
      if (extras.length) lines.push(`    ${extras.join('   ')}`);
    }
  }
  return lines.join('\n');
}

/** What changed between two plans, one line per game whose numbers or places moved. */
export function diffPlans(before: RotaPlan, after: RotaPlan): string[] {
  const lines: string[] = [];
  const old = new Map(before.games.map((g) => [g.id, g]));
  for (const game of after.games) {
    const was = old.get(game.id);
    if (!was) {
      lines.push(`${game.label}: new on the plan (${formatDay(game.date)})`);
      continue;
    }
    const parts: string[] = [];
    if (was.date !== game.date) parts.push(`moved ${formatDay(was.date)} to ${formatDay(game.date)}`);
    if (was.deltaNow !== game.deltaNow || was.rag !== game.rag) {
      parts.push(`${signed(was.deltaNow)} ${was.rag} to ${signed(game.deltaNow)} ${game.rag}`);
    }
    const wasGoing = new Set([...was.booked, ...was.placed]);
    const nowGoing = new Set([...game.booked, ...game.placed]);
    const joined = [...nowGoing].filter((p) => !wasGoing.has(p));
    const left = [...wasGoing].filter((p) => !nowGoing.has(p));
    if (joined.length) parts.push(`in: ${joined.join(', ')}`);
    if (left.length) parts.push(`out: ${left.join(', ')}`);
    if ((was.lead ?? '') !== (game.lead ?? '')) parts.push(`lead ${was.lead ?? 'none'} to ${game.lead ?? 'none'}`);
    if (parts.length) lines.push(`${game.label}: ${parts.join('; ')}`);
  }
  for (const was of before.games) {
    if (!after.games.some((g) => g.id === was.id)) lines.push(`${was.label}: off the plan`);
  }
  return lines;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function saturdayHtml(saturday: SaturdayPlan, games: GamesPlan[]): string {
  const rows = games
    .map((game) => {
      const places = placesOf(game)
        .map((place) => `<li class="place ${place.kind}">${escapeHtml(placeText(place))}</li>`)
        .join('');
      const extras = [
        game.supporting.length ? `<p><strong>Supporting:</strong> ${escapeHtml(game.supporting.join(', '))}</p>` : '',
        game.spare.length ? `<p><strong>Spare:</strong> ${escapeHtml(game.spare.join(', '))}</p>` : '',
        game.maybes.length ? `<p><strong>Maybe:</strong> ${escapeHtml(game.maybes.join(', '))}</p>` : '',
      ].join('');
      return `<tr>
  <th scope="row">${escapeHtml(game.label)}</th>
  <td>${game.target}</td>
  <td><span class="rag ${game.rag.toLowerCase()}">${signed(game.deltaNow)} ${game.rag}</span></td>
  <td>${escapeHtml(leadText(game))}</td>
  <td>${game.problems ? escapeHtml(game.problems) : 'Nothing wrong'}</td>
  <td><ol class="places">${places}</ol>${extras}</td>
</tr>`;
    })
    .join('\n');
  return `<section aria-labelledby="sat-${saturday.date}">
<h2 id="sat-${saturday.date}">${formatDay(saturday.date)} <span class="rag ${saturday.rag.toLowerCase()}">${signed(saturday.deltaNow)} ${saturday.rag}</span></h2>
<p>Need ${saturday.need}, counted ${saturday.counted}, maybe ${saturday.maybe}${saturday.games.length > 1 ? '. Each person is counted once across the day.' : '.'}</p>
<div class="scroll"><table>
<caption>Games on ${formatDay(saturday.date)}</caption>
<thead><tr><th scope="col">Games</th><th scope="col">Target</th><th scope="col">Short or spare</th><th scope="col">Lead</th><th scope="col">Problem</th><th scope="col">Places</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
</section>`;
}

export function renderPlanHtml(plan: RotaPlan, title = 'Ghillie plan'): string {
  const sections = plan.saturdays.map((saturday) => saturdayHtml(saturday, plan.games.filter((g) => g.date === saturday.date))).join('\n');
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1rem; color: #1f2933; line-height: 1.4; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.15rem; margin-top: 2rem; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 40rem; }
  th, td { border: 1px solid #cbd2d9; padding: 0.5rem; text-align: left; vertical-align: top; }
  caption { text-align: left; font-weight: 600; padding: 0.25rem 0; }
  .rag { font-weight: 600; padding: 0 0.3rem; border-radius: 0.2rem; }
  .rag.green { background: #c6f0d6; color: #0b4d26; }
  .rag.amber { background: #fde7b0; color: #5c3d00; }
  .rag.red { background: #f8c7c3; color: #6b0f0a; }
  ol.places { margin: 0; padding-left: 1.25rem; }
  .place.stewarding { font-weight: 600; }
  .place.pencilled { color: #1d4f91; }
  .place.short { color: #6b0f0a; font-weight: 600; }
  .place.beyond { color: #616e7c; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>As at ${formatDay(plan.today)}. A suggested split, never a booking: only the organiser books.</p>
${sections}
</main>
</body>
</html>
`;
}
