'use client';
/**
 * The room demo, hosted. Each visitor gets their own fortnight (its id is kept in this browser), runs it one tick at
 * a time, and watches the agent work: what came in, each model request and tool call with the guard's answer, the
 * message Isla gets, and the rota with whatever changed highlighted.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cellKey, chipDay, chipHour, clockOf, fmtDay, fmtShort, fmtTick, money, secs, sourceWords, valueClass, valueText, withLabels, type Labels } from '@/lib/format';
import type { Message, Row, RunMode, State } from '@/lib/messages';
import { begin, finish, fold, segments, type AgentRow, type Tick } from '@/lib/tick';

const runKey = 'ghillie-run';

const store = {
  get: (): string | null => {
    try {
      return localStorage.getItem(runKey);
    } catch {
      return null;
    }
  },
  set: (id: string): void => {
    try {
      localStorage.setItem(runKey, id);
    } catch {
      /* private mode: the run lasts as long as the page */
    }
  },
};

async function postJson(path: string, body: unknown, method = 'POST'): Promise<Response> {
  return fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
}

const errorOf = async (res: Response): Promise<string> => {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `the server said ${res.status}`;
};

function defaultMode(state: State): RunMode {
  const row = state.rows[state.index];
  if (state.live.open && row?.scene && !row.scene.free) return 'live';
  if (row?.recorded && row.scene) return 'replay';
  return 'stand-in';
}

export function RoomDemo(): ReactNode {
  const [state, setState] = useState<State | null>(null);
  const [mode, setMode] = useState<RunMode | null>(null);
  const [speed, setSpeed] = useState(1);
  const [tick, setTick] = useState<Tick | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState(0);
  const [version, setVersion] = useState(0);
  const tickRef = useRef<Tick | null>(null);

  const labels: Labels = useMemo(() => Object.fromEntries((state?.grid.events ?? []).map((e) => [e.id, e.label])), [state?.grid.events]);
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  const takeState = useCallback((next: State) => {
    setState((prev) => {
      if (prev && prev.index !== next.index) setMode(null);
      return next;
    });
    setVersion((v) => v + 1);
  }, []);

  const newRun = useCallback(async () => {
    const res = await postJson('/api/runs', {});
    if (!res.ok) throw new Error(await errorOf(res));
    const next = (await res.json()) as State;
    store.set(next.runId);
    setTick(null);
    tickRef.current = null;
    setMode(null);
    takeState(next);
  }, [takeState]);

  const refresh = useCallback(
    async (id: string): Promise<State | null> => {
      const res = await fetch(`/api/runs/${id}`, { cache: 'no-store' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(await errorOf(res));
      const next = (await res.json()) as State;
      takeState(next);
      return next;
    },
    [takeState],
  );

  // Find this browser's run, or start one. Once per page, even where React runs effects twice in development.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    const id = store.get();
    (id ? refresh(id) : Promise.resolve(null))
      .then((found) => (found ? undefined : newRun()))
      .catch((error: unknown) => setNotice(`Could not load the demo: ${error instanceof Error ? error.message : String(error)}`));
  }, [refresh, newRun]);

  // A tick left running by an earlier visit (a reload mid-tick): wait for it to finish and be saved.
  useEffect(() => {
    if (!state?.busy || running) return;
    const timer = setInterval(() => void refresh(state.runId), 3000);
    return () => clearInterval(timer);
  }, [state?.busy, state?.runId, running, refresh]);

  // The clock on a running tick.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(timer);
  }, [running]);

  const onMessage = useCallback(
    (m: Message) => {
      const at = performance.now();
      setNow(at);
      if (m.type === 'state') takeState(m);
      else if (m.type === 'tick-start') {
        tickRef.current = begin(m, at);
        setNotice(null);
      } else if (m.type === 'step' && tickRef.current) tickRef.current = fold(tickRef.current, m, at, labelsRef.current);
      else if (m.type === 'tick-end' && tickRef.current) {
        tickRef.current = finish(tickRef.current, m, at, labelsRef.current);
        if (m.error) setNotice(<><b>This tick did not finish:</b> {m.error}{m.run ? '' : ' It has not been counted. Run it again, or switch to Replay.'}</>);
      } else if (m.type === 'error') setNotice(m.error);
      setTick(tickRef.current);
    },
    [takeState],
  );

  const act = useCallback(
    async (body: Record<string, unknown>) => {
      if (!state || running || state.busy || state.finished) return;
      setRunning(true);
      setNotice(null);
      try {
        const res = await postJson(`/api/runs/${state.runId}/act`, body);
        if (!res.ok || !res.body) {
          setNotice(await errorOf(res));
          return;
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let nl = buffer.indexOf('\n');
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) onMessage(JSON.parse(line) as Message);
            nl = buffer.indexOf('\n');
          }
        }
      } catch (error) {
        setNotice(`The connection dropped: ${error instanceof Error ? error.message : String(error)}. The tick carries on and is saved; this page will catch up.`);
        void refresh(state.runId);
      } finally {
        setRunning(false);
      }
    },
    [state, running, onMessage, refresh],
  );

  const current = state ? (mode ?? defaultMode(state)) : 'stand-in';
  const row = state?.rows[state.index];
  const busy = running || Boolean(state?.busy);
  const run = useCallback(() => void act({ action: 'step', mode: current, speed }), [act, current, speed]);
  const skip = useCallback(() => void act({ action: 'skip' }), [act]);
  const reset = useCallback(() => {
    if (confirm('Start the fortnight again from a fresh rota?')) newRun().catch((error: unknown) => setNotice(String(error)));
  }, [newRun]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) {
        e.preventDefault();
        run();
      } else if (e.key === 'f' || e.key === 'F') skip();
      else if (e.key === '1' && state?.live.open) setMode('live');
      else if (e.key === '2' && row?.recorded) setMode('replay');
      else if (e.key === '3') setMode('stand-in');
      else if (e.key === 'r' || e.key === 'R') {
        const rota = document.querySelector<HTMLElement>('.rota');
        if (rota) window.scrollTo({ top: rota.getBoundingClientRect().top > window.innerHeight / 2 ? rota.offsetTop - 8 : 0, behavior: 'smooth' });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [run, skip, state?.live.open, row?.recorded]);

  if (!state) return <div className="loading">{notice ?? 'Setting out the rota…'}</div>;

  return (
    <>
      <header>
        <div className="brand">
          <b>Ghillie</b>
          <span>keeps the Highland games rota true, and proposes rather than decides</span>
        </div>
        <div className="clock">
          <small>In the story</small>
          {tick ? fmtTick(tick.start.at) : 'Before the fortnight'}
        </div>
        <div className="money">
          <div>
            This run <b>{money(state.spent)}</b>
          </div>
          <div>{state.live.configured ? `Live spend ${money(state.live.total)} of the $${state.live.cap} cap · ${state.model}` : 'Replays and the stand-in only'}</div>
        </div>
      </header>

      <Intro state={state} onChange={() => void refresh(state.runId)} />

      <div className="timeline">
        {state.rows.map((r, i) => (
          <Chip key={r.at} row={r} next={i === state.index} />
        ))}
      </div>

      <div className="bar">
        <Cue row={row} />
        <div className="controls">
          <div className="seg" role="group" aria-label="How the next tick runs">
            <button aria-pressed={current === 'live'} disabled={!state.live.open} onClick={() => setMode('live')} title={state.live.open ? 'A real Managed Agents session (key 1)' : 'Live ticks need the password'}>
              Live
            </button>
            <button aria-pressed={current === 'replay'} disabled={!row?.recorded} onClick={() => setMode('replay')} title={row?.recorded ? 'A recorded session, played back for free (key 2)' : 'No recording of this tick yet'}>
              Replay
            </button>
            <button aria-pressed={current === 'stand-in'} onClick={() => setMode('stand-in')} title="The rule-based stand-in, free and instant (key 3)">
              Stand-in
            </button>
          </div>
          {current === 'replay' && (
            <select aria-label="Replay speed" title="Replay speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
              <option value={4}>4×</option>
            </select>
          )}
          <button className="go" disabled={busy || state.finished} onClick={run}>
            {state.finished ? 'Fortnight over' : busy ? 'Running…' : `Run ${row ? fmtShort(row.at) : ''} ▸`}
          </button>
          <button className="ghost" disabled={busy || state.finished} onClick={skip} title="Stand-in up to the next ★ (key F)">
            Next ★
          </button>
          <button className="ghost" disabled={running} onClick={reset} title="Start the fortnight again">
            Start again
          </button>
        </div>
      </div>
      <div className={`notice ${notice ? 'on' : ''}`}>{notice}</div>
      {state.busy && !running && <div className="notice on">A tick from an earlier visit is still running. This page will catch up when it is saved.</div>}

      <main>
        <Evidence tick={tick} labels={labels} />
        <AgentPanel tick={tick} now={now} />
        <Phone tick={tick} />
      </main>

      <Rota state={state} tick={tick} version={version} />
    </>
  );
}

function Intro({ state, onChange }: { state: State; onChange: () => void }): ReactNode {
  const [open, setOpen] = useState(true);
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const unlock = async (): Promise<void> => {
    setMessage('');
    const res = await postJson('/api/unlock', { password });
    if (res.ok) {
      setPassword('');
      onChange();
    } else setMessage(await errorOf(res));
  };
  const lock = async (): Promise<void> => {
    await postJson('/api/unlock', {}, 'DELETE');
    onChange();
  };
  return (
    <div className="intro">
      <div>
        <h2>An agent that keeps a volunteer rota true</h2>
        {open ? (
          <>
            <p>
              Six Saturday Highland games, a committee that talks in chat, mail and call notes, and Isla, who organises. Ghillie reads what was said since its last run, records answers on the rota,
              proposes recruits rather than adding them, and messages Isla. Everyone and everywhere here is invented.
            </p>
            <ul>
              <li>
                <b>Run</b> plays the next half-day of the committee&apos;s fortnight. The ★ ticks are the interesting ones.
              </li>
              <li>
                <b>Replay</b> plays back a real recorded session on Claude Managed Agents, free. <b>Stand-in</b> is a rule-based version with no model, for the quiet ticks.
              </li>
              <li>
                <b>Live</b> runs a new session on Managed Agents. It costs a little, so it needs the password.
              </li>
            </ul>
            <p>This fortnight is yours: nobody else sees it, and Start again gives you a fresh rota.</p>
          </>
        ) : null}
      </div>
      <div className="lock">
        {state.live.unlocked ? (
          <>
            <span className="ok">Live ticks unlocked</span>
            <button className="ghost" onClick={() => void lock()}>
              Lock
            </button>
          </>
        ) : state.live.configured ? (
          <form
            className="lock"
            onSubmit={(e) => {
              e.preventDefault();
              void unlock();
            }}
          >
            <input type="password" placeholder="Password for live" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password for live ticks" autoComplete="current-password" />
            <button className="ghost" type="submit" disabled={!password}>
              Unlock live
            </button>
            {message && <span>{message}</span>}
          </form>
        ) : (
          <span>Live ticks are off on this server.</span>
        )}
        <button className="ghost" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'What is this?'}
        </button>
      </div>
    </div>
  );
}

function Chip({ row, next }: { row: Row; next: boolean }): ReactNode {
  const cls = ['chip', row.scene ? 'scene' : '', next ? 'next' : '', row.done ? `done-${row.done}` : '', row.recorded ? 'recorded' : ''].join(' ');
  return (
    <div className={cls} title={`${row.scene?.title ?? ''}${row.recorded ? ' (recorded)' : ''}`}>
      <b>{chipDay(row.at)}</b>
      {chipHour(row.at)}
    </div>
  );
}

function Cue({ row }: { row: Row | undefined }): ReactNode {
  if (!row)
    return (
      <div className="cue">
        <h2>The fortnight is over</h2>
        <p>Start again for a fresh rota, or look over this one below.</p>
      </div>
    );
  const s = row.scene;
  return (
    <div className="cue">
      {s ? (
        <>
          <h2>★ {s.title}</h2>
          <p>
            <b>Next: {fmtTick(row.at)}.</b> {s.watch}
          </p>
        </>
      ) : (
        <>
          <h2>{fmtTick(row.at)}</h2>
          <p>{row.skipped ?? 'A routine tick. Fast-forward with the stand-in, or run it.'}</p>
        </>
      )}
    </div>
  );
}

function Evidence({ tick, labels }: { tick: Tick | null; labels: Labels }): ReactNode {
  const bad = Object.entries(tick?.start.sources ?? {}).filter(([, v]) => v !== 'ok');
  return (
    <section className="panel">
      <h3>
        <span>What came in</span>
        <span>
          {bad.map(([k, v]) => (
            <span key={k} className="tag warn">
              {sourceWords[k] ?? k}: {v}
            </span>
          ))}
        </span>
      </h3>
      <div className="body">
        {!tick ? (
          <p className="empty">Run a tick to see what the committee said since the last run.</p>
        ) : !tick.start.console.length && !tick.start.items.length ? (
          <p className="empty">Nothing new since the last run.</p>
        ) : (
          <>
            {tick.start.console.map((c, i) => (
              <div key={`c${i}`} className="isla">
                {withLabels(c, labels)}
              </div>
            ))}
            {tick.start.items.map((it, i) => {
              const src = sourceWords[it.source] ?? it.source;
              return (
                <div key={`i${i}`} className={`ev ${it.source} ${it.alreadyRead ? 'read' : ''}`}>
                  <div className="meta">
                    <b>{it.who || 'unknown'}</b>
                    <span>
                      {src}
                      {it.label && it.label !== src ? ` · ${it.label}` : ''}
                    </span>
                    <span>{fmtShort(it.at)}</span>
                    {it.trusted && <span className="tag">Isla&apos;s own channel</span>}
                    {it.alreadyRead && <span className="tag">read before</span>}
                  </div>
                  <div className="text">{it.text}</div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </section>
  );
}

function AgentRowView({ row, at, end }: { row: AgentRow; at: number; end: number }): ReactNode {
  const t = (ms: number): ReactNode => <span className="t">{clockOf(ms)}</span>;
  const dot = <span className="dot" />;
  if (row.kind === 'status')
    return (
      <div className="row status">
        {t(row.t)}
        {dot}
        <div className="c">
          <div className="line">{row.text}</div>
        </div>
      </div>
    );
  if (row.kind === 'model')
    return (
      <div className={`row model ${row.t1 === undefined ? 'active' : ''}`}>
        {t(row.t0)}
        {dot}
        <div className="c">
          <div className="line">
            <span className="kind">MODEL</span>
            <span>{row.text ?? 'thinking'}</span>
            <span className="dur">{secs((row.t1 ?? Math.min(at, end)) - row.t0)}</span>
          </div>
        </div>
      </div>
    );
  if (row.kind === 'tool')
    return (
      <div className={`row tool ${row.t1 === undefined ? 'active' : ''} ${row.bad ? 'bad' : ''}`}>
        {t(row.t0)}
        {dot}
        <div className="c">
          <div className="line">
            <span className="kind">TOOL</span>
            <b>{row.title}</b>
            <span className="dur">{secs((row.t1 ?? Math.min(at, end)) - row.t0)}</span>
          </div>
          {row.args && <div className="args">{row.args}</div>}
          <div className="verdicts">
            {row.guard !== undefined && <span className={`pill ${row.guard ? 'ok' : 'no'}`}>{row.guard ? 'Guard: allowed' : 'Guard refused'}</span>}
            {row.pill ? <span className={`pill ${row.pill.cls}`}>{row.pill.text}</span> : <span className="pill wait">session paused, waiting on the repo</span>}
          </div>
        </div>
      </div>
    );
  if (row.kind === 'note')
    return (
      <div className="row note">
        {t(row.t)}
        {dot}
        <div className="c">
          <div className="line">
            <span className="kind" style={{ color: 'var(--moss)' }}>
              GHILLIE
            </span>
            <b>its own note</b>
          </div>
          <div className="notebox">{row.text}</div>
        </div>
      </div>
    );
  return (
    <div className={`row ${row.propose ? 'note' : 'tool'} ${row.bad ? 'bad' : ''}`}>
      {t(0)}
      {dot}
      <div className="c">
        <div className="line">
          <span className="kind" style={row.propose ? { color: 'var(--moss)' } : undefined}>
            {row.propose ? 'PROPOSE' : 'WRITE'}
          </span>
          <b>{row.title}</b>
        </div>
        <div className="args">{row.detail}</div>
        <div className="verdicts">
          <span className={`pill ${row.pill.cls}`}>{row.pill.text}</span>
        </div>
      </div>
    </div>
  );
}

function AgentPanel({ tick, now }: { tick: Tick | null; now: number }): ReactNode {
  const bodyRef = useRef<HTMLDivElement>(null);
  const count = tick?.rows.length ?? 0;
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [count]);
  const at = tick ? now - tick.startedAt : 0;
  const end = tick?.endedAt ? tick.endedAt - tick.startedAt : at;
  const total = Math.max(1, end);
  const segs = tick ? segments(tick, now) : [];
  const sum = (k: 'model' | 'tool'): number => segs.filter((s) => s.kind === k || (k === 'tool' && s.kind === 'refused')).reduce((a, s) => a + (s.t1 - s.t0), 0);
  const where = tick?.start.mode === 'live' ? 'live on Managed Agents' : tick?.start.mode === 'replay' ? 'replay of a recorded session' : tick?.start.mode === 'stand-in' ? 'rule-based stand-in, no model' : '';
  const e = tick?.end;
  return (
    <section className="panel">
      <h3>
        <span>Ghillie at work</span>
        <span>{where}</span>
      </h3>
      <div className="strip-wrap">
        <div className="strip">
          {segs.map((s, i) => (
            <span key={i} className={`seg-bar ${s.kind}`} style={{ left: `${(s.t0 / total) * 100}%`, width: `${Math.max(0.4, ((s.t1 - s.t0) / total) * 100)}%` }} />
          ))}
        </div>
        <div className="legend">
          <span>
            <i style={{ background: 'var(--heather)' }} />
            model
          </span>
          <span>
            <i style={{ background: 'var(--slate)' }} />
            repo answering a tool call
          </span>
          <span>
            <i style={{ background: '#d9d2c3' }} />
            platform between steps
          </span>
          <span>
            <i style={{ background: 'var(--red)' }} />
            refused
          </span>
          <span className="totals">{segs.length ? `model ${secs(sum('model'))} · repo ${secs(sum('tool'))} · platform ${secs(Math.max(0, total - sum('model') - sum('tool')))}` : ''}</span>
        </div>
      </div>
      <div className="body" ref={bodyRef}>
        <div className="steps">
          {!tick ? (
            <p className="empty">Each model request, each tool call, the guard&apos;s answer on every write, and what the service did.</p>
          ) : tick.rows.length ? (
            tick.rows.map((r, i) => <AgentRowView key={i} row={r} at={at} end={end} />)
          ) : (
            <p className="empty">{tick.start.mode === 'stand-in' ? 'The stand-in runs in milliseconds and calls no model.' : 'No run this slot.'}</p>
          )}
        </div>
      </div>
      <div className="foot">
        <span>{tick?.session}</span>
        <span>
          {e
            ? `${e.durationMs < 1000 ? `${(e.durationMs / 1000).toFixed(2)} s` : clockOf(e.durationMs)}${e.usd ? ` · ${money(e.usd)}` : ''}${tick?.requests ? ` · ${tick.requests} model requests` : ''}`
            : tick
              ? clockOf(at)
              : ''}
        </span>
      </div>
    </section>
  );
}

function Phone({ tick }: { tick: Tick | null }): ReactNode {
  const e = tick?.end;
  const bubbles: ReactNode[] = [];
  if (e?.skipped) bubbles.push(<div key="skip" className="bubble quiet">No run: {e.skipped}.</div>);
  if (e?.run) bubbles.push(e.run.message ? <div key="msg" className="bubble">{e.run.message}</div> : <div key="none" className="bubble quiet">No message. Nothing needs her.</div>);
  for (const [i, w] of (e?.watchdog ?? []).entries())
    bubbles.push(
      <div key={`w${i}`} className="bubble alarm">
        <b>Watchdog, 20:00.</b> {w}
      </div>,
    );
  return (
    <section className="panel">
      <h3>
        <span>Isla&apos;s phone</span>
        <span />
      </h3>
      <div className="body">
        <div className="phone">
          <div className="who">Ghillie → Isla</div>
          <div>{tick && !e ? <div className="bubble quiet">…</div> : bubbles.length ? bubbles : <div className="bubble quiet">{tick ? 'Nothing.' : 'Nothing yet.'}</div>}</div>
        </div>
        {e?.run && (
          <div className="tally">
            <span className="pill ok">{e.mainWrites.length} written</span>
            <span className={`pill ${e.run.refused.length ? 'no' : ''}`}>{e.run.refused.length} refused by the service</span>
            <span className="pill">{e.run.proposals.length} proposed to Isla</span>
            <span className="pill">{e.run.toolCalls} tool calls</span>
          </div>
        )}
      </div>
    </section>
  );
}

function Rota({ state, tick, version }: { state: State; tick: Tick | null; version: number }): ReactNode {
  const { grid, plan } = state;
  const cells = new Map(grid.cells.map((c) => [cellKey(c.person, c.event), c]));
  const before = state.previousCells ? new Map(state.previousCells.map((c) => [cellKey(c.person, c.event), c])) : null;
  const games = new Map(plan.games.map((g) => [g.id, g]));
  const prevGames = new Map((state.previousPlan?.games ?? []).map((g) => [g.id, g]));

  // While a tick runs, the cells its tool calls touch, write and are refused on.
  const live = tick && !tick.end ? tick.rows : [];
  const touching = new Set<string>();
  const written = new Map<string, string>();
  const refused = new Set<string>();
  let colTouch = '';
  for (const r of live) {
    if (r.kind !== 'tool') continue;
    const person = typeof r.input.person === 'string' ? r.input.person : '';
    const event = typeof r.input.event === 'string' ? r.input.event : '';
    if (r.t1 === undefined && r.name === 'update_event' && event) colTouch = event;
    if (!person || !event) continue;
    const k = cellKey(person, event);
    if (r.t1 === undefined) touching.add(k);
    if (r.written && typeof r.input.value === 'string') written.set(k, r.input.value);
    if (r.bad) refused.add(k);
  }

  const chip = (v: string, pen: boolean): ReactNode => (
    <span className={`v ${valueClass[v] ?? 'v-unk'} ${pen ? 'pen' : ''}`} title={`${v || 'Unknown'}${pen ? ', pencilled by Isla' : ''}`}>
      {valueText(v)}
    </span>
  );

  return (
    <div className="rota">
      <h3>
        <span>The rota: a suggested split, never a booking</span>
        <span>
          as at {fmtDay(plan.today)} · <span className="keys">keys: → run, F next ★, R rota, 1 2 3 mode</span>
        </span>
      </h3>
      <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="who">{grid.people.length} people</th>
              {grid.events.map((e) => (
                <th key={e.id} className={colTouch === e.id ? 'col-touch' : ''}>
                  {e.label.replace(/ Games$/, '')}
                  <small>
                    {e.type === 'Setup day' ? 'Setup, ' : ''}
                    {fmtDay(e.date)}
                  </small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="cover">
              <td className="who">
                <b>Cover</b> <small>counted / needed</small>
              </td>
              {grid.events.map((e) => {
                const g = games.get(e.id);
                if (!g) {
                  const yes = grid.cells.filter((c) => c.event === e.id && ['Yes', 'Stewarding', 'Supporting'].includes(c.value)).length;
                  return (
                    <td key={e.id}>
                      <span className="status">{yes} yes</span>
                    </td>
                  );
                }
                const was = prevGames.get(e.id);
                const moved = Boolean(state.previousPlan && was && (was.rag !== g.rag || was.counted !== g.counted));
                return (
                  <td key={`${e.id}-${version}`}>
                    <span className={`rag ${g.rag} ${moved ? 'changed' : ''}`} title={g.problems || ''}>
                      {g.counted}/{g.target}
                    </span>
                  </td>
                );
              })}
            </tr>
            {grid.people.map((p) => {
              const role = p.role && p.role !== 'Steward' ? p.role : p.status === 'Pipeline' ? 'pipeline' : '';
              return (
                <tr key={p.name} className={p.status === 'Pipeline' ? 'pipeline' : ''}>
                  <td className="who">
                    {p.name}
                    {role && <small title={role}>{role}</small>}
                  </td>
                  {grid.events.map((e) => {
                    const k = cellKey(p.name, e.id);
                    const c = cells.get(k);
                    const b = before?.get(k);
                    const now = written.get(k);
                    const changed = now !== undefined || Boolean(before && ((c?.value ?? '') !== (b?.value ?? '') || Boolean(c?.pencilled) !== Boolean(b?.pencilled)));
                    const cls = ['cell', changed ? 'changed' : '', touching.has(k) ? 'touch' : '', refused.has(k) ? 'refused' : ''].join(' ');
                    return (
                      <td key={`${e.id}-${version}-${now ?? ''}`} className={cls}>
                        {chip(now ?? c?.value ?? '', Boolean(c?.pencilled))}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
