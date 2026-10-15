# Ghillie

A Highland games needs forty volunteers, a tug-of-war marshal with strong views, and a piper who has been about to drop out since the committee last changed its mind. Ghillie reads the committee's chat, mail and minutes, keeps the rota true, and proposes rather than decides, so the organiser hears only about what needs her.

> Phase 1b: the same agent built three ways, on the Phase 1a foundation, each run live against the same 37 eval cases. `npm run demo` replays a recorded live fortnight of the Messages API build, for free. Phase 1b's live runs cost $32.74 in all.

## What it is

A rota engine and an MCP server for a summer circuit of Highland games, set in an invented corner of Scotland: six Saturday games across villages such as Glen Dunnock, Kinloch-on-Spey and Balvaig Bridge, two of them on the same Saturday, and a Friday setup day. Isla organises. Morven, Hamish and Eilidh are the Chief Stewards. Everyone and everywhere in it is fictional.

Twice a weekday the agent reads what was said since its last run, records people's availability through the MCP tools, works out what changed, and messages Isla only when something needs her. It never books anyone, never adds anyone, never messages anyone else and never moves a date: Isla does those, and the agent carries out what she has approved, once.

```
packages/engine       the rules: store, write guards, coverage, the suggested split, exceptions, watchdog, plan renderers
packages/mcp-server   the stdio MCP server: eight tools, strict schemas, every write through the engine's guards
packages/feed         the fictional circuit, its seeded fortnight, and adapters that read it like chat, mail, minutes, calendar
packages/stand-in     a deterministic rule-based stand-in for the agent, so the demo and the evals run with no model
packages/agent-kit    what the three builds share: the prompt, the brief, the guard, the tool catalogue, the run recorder
packages/agent-messages  the agent as a hand-written Messages API loop
packages/agent-sdk    the agent on the Agent SDK
packages/agent-managed   the agent on Managed Agents, with its resource files
packages/ledger       the cost ledger: every response's usage, priced, with a hard stop at $60
apps/demo             the demo: the recorded Messages API run replayed for free, or the stand-in
apps/live             the room demo: a local page that runs the fortnight tick by tick on Managed Agents
evals                 the cases, the graders and the report
docs                  the rules (docs/rules.md) and the decisions (docs/decisions)
```

## The 60-second demo

```
nvm use          # Node 22
npm ci
npm run demo
```

It seeds a fresh store, prints the plan, then plays a fortnight in June 2027 in half-day ticks. After each tick it prints what was written (with the source and the time it was said), what the service refused, what was proposed to Isla, the exact message she received, and the run's log line. At the end: the plan with what changed, the append-only change log, the approval queue, a cost ledger (zero for the stand-in; the recorded cost for a replay), and the watchdog alert for the evening the host slept through a run. The plan is also written to `out/plan.html`.

`npm run demo:replay-twice` plays the fortnight, then replays every window again and shows zero net writes.

Along the way: a volunteer tells the agent to make him Chief Steward (it is data, not an instruction); someone is "away mid-July" (Maybe, words quoted, raised); someone gives a span of dates with a medical reason in the middle of it (only the dates survive, anywhere); a yes depends on a lift; a games date moves; the mail source hangs; the call notes are filed under the wrong meeting with a name misheard, and arrive late; a recruit is suggested twice; Isla books someone at both games on one Saturday; and the piper pulls out in a reply the mail search did not show.

## In a room

```
npm run live     # then open http://127.0.0.1:4317
```

A page for showing the Managed Agents build to people, one tick at a time. It shows what came in since the last run, the agent at work (each model request, each tool call, the guard's answer on every write before the session resumes, and what the service did), the message Isla receives, and the rota, with whatever changed highlighted. Eight ticks are marked as scenes, with a cue for the presenter: Dougie ordering Ghillie to make him Chief Steward, a games date the calendar moves, Isla booking Dougie twice on one Saturday, the piper pulling out, and others.

Each tick runs one of three ways, chosen on the page:

- **Live**: a real session on the agent and environment in `packages/agent-managed/resources/ids.json`, under the ledger and the $2 session budget. About 80 seconds and about $0.10 a tick. Each live session is recorded to `recordings/managed-live/`.
- **Replay**: a recorded session played back at its own pace or faster. Nothing is spent, the tool calls still run against the real server, and every write still goes through the guard. It is also the fallback if the room's network fails: a live tick that fails is not counted, so it can be run again as a replay.
- **Stand-in**: the rule-based stand-in, free and instant, for the ticks between the scenes.

Keys: right arrow, space or a presenter's clicker runs the next tick; F fast-forwards to the next scene; R jumps to the rota and back; 1, 2 and 3 pick the mode. Live is offered only when the API-key variable is set, in the environment or in `.env`. The page listens on the loopback address only.

## Three ways

The same agent, on the same MCP server, with the same system prompt, brief and graders, built three times. What each
layer did, what broke and when I would choose each is in [docs/comparison.md](docs/comparison.md).

- **By hand on the Messages API** (`packages/agent-messages`, 271 lines; the loop is 124): the full history resent each
  call, every stop reason routed, the turn limit counted in code, every tool call checked against the server's schema
  before it runs, results keyed by call id with errors marked, a trace and a cost for every turn, the stable prompt
  first with a cache breakpoint and the evidence last, and server-side fallbacks on. Cassettes record a live run so the
  demo can replay it for free. Live on Sonnet 5.5: 34 of 37 (91.9%), then three repeats at 89.2%, 86.5% and 89.2%
  (pooled 98 of 111, 88.3%, 95% Wilson interval 81.0% to 93.0%); a median of $0.092 a tick; 15 s a tick at the median.
  On Opus 5.5: 35 of 37 (94.6%) at a median of $0.171 a tick.
- **On the Agent SDK** (`packages/agent-sdk`, 313 lines): deny by default, with only the server's eight tools, named in
  code, and nothing from the machine's settings; a pre-tool-use hook that re-checks every call with the engine's own
  authority rule; an audit trail from the hooks; sessions resumable by tick id; turn and spend ceilings on every run.
  Each control, its file and its test: [packages/agent-sdk/CONTROLS.md](packages/agent-sdk/CONTROLS.md). Live on
  Sonnet 5.5: 34 of 37 (91.9%, 78.7% to 97.2%), a median of $0.087 a tick, 17 s.
- **On Managed Agents** (`packages/agent-managed`, 569 lines): agent, environment and deployment as files in the
  `ant apply` layout, or created once in code and kept by id; every built-in tool off; networking limited to an empty
  host list; every write confirmed first while the session waits; a $2 budget on every session; a weekday 13:00 and
  18:00 schedule with a daily cap, a worker and a morning-after report. The rota tools are custom tools with the
  server's own names and schemas, run by the repo, because the platform's MCP connector would need the server on the
  internet. The server also has a loopback-only HTTP transport for the day it is hosted. Live on Sonnet 5.5: 35 of 37
  (94.6%, 82.3% to 98.5%), a median of $0.092 a tick, but 80 s a tick, since every tool call is a round trip. The
  deployment exists and is paused until a worker is there to serve it.

On pass rate the three cannot be told apart at this sample size, and on cost they are within a cent a tick. The same
few cases failed on every build, which points at the shared prompt rather than any framework. All results are in
`evals/results/`.

Every write any build makes still goes through the Phase 1a service. The authority rule (an approval the organiser
granted for exactly this action, used once, in full mode) is one function that the service and every harness check
call, so they cannot disagree.

To run them again, set the API-key variable named in `.env.example` (for example `set -a; . ./.env; set +a`), then:

```
npm run eval:live -- --impl messages --repeats 3     # also: --impl sdk, --impl managed; --model claude-opus-5-5
npm run managed -- setup                             # once, before --impl managed
npm run demo:live                                    # records the fortnight; npm run demo then replays it
```

Every call goes through the ledger (`ledger/spend.jsonl`), which prints the running total, refuses to start a call once
$60 has been spent, and stops the process when a call passes it. The cap is a constant in the code.

## The rules it keeps

The full list, with ids, is in [docs/rules.md](docs/rules.md). In short:

- The most recent statement wins, and a person's own word beats anyone's summary of it.
- Evidence time is not write time: a write is refused if the log already holds something newer, however late the older evidence arrives.
- "Until X" means up to X, not including it. A phrase that does not pin down days is never Yes.
- Only the organiser books, and only what she approved, once. A leaning is not a decision.
- One place at a time: staff the Saturday, not the game.
- Recruits are suggested, never added, and never suggested again without new evidence.
- Nothing a source said is stored or sent except date words, which the service writes itself. Medical and personal reasons appear nowhere.
- The organiser is recognised by her own sender id on her own channel, never by a name.
- A source that could not be read is never an all clear; a watchdog notices a run that did not happen.
- Nobody three Saturdays in a row; a week off resets it; and when someone tops out, the message says whose limit it is.
- No exceptions and no readings means no message.

## What is tested

- `npm test`: 323 tests pass and 1 is skipped (a live cache check that runs only with `GHILLIE_LIVE=1` and a key; run once live, it read 9,730 tokens from cache on the second tick). Engine 121, stand-in 37, agent kit 31, eval harness 30, MCP server 16 (stdio and loopback HTTP), demo 16, Messages API build 14, Managed Agents build 14, feed 13, Agent SDK build 11, ledger 8, deny-list 7, room demo 5. They cover the engine (coverage, the split, over-use, every write guard, the security findings, the closed date grammar), the MCP server over real stdio and HTTP transports, the feed adapters, the stand-in (including spoofing the organiser across chat, mail and call notes), the whole fortnight, the deny-list, and for Phase 1b: every stop reason of the hand-written loop replayed through a stubbed client; the Agent SDK's deny-by-default options, a forged approval refused by the hook, and a kill and resume that loses and repeats no decision; Managed Agents' pause, answer and resume on every write; the ledger's hard stop; cassette replay; and every adversarial authority case run through both the harness check and the service, with identical refusals required. The HTTP test binds a local port.
- `npm run eval`: cases rewritten from 24 templates into this world, plus cases for the planted traps. Each cites the rules its expected outcome follows from. Graders are deterministic, each has a seeded-fault test that turns it red, and the report gives n with a 95% Wilson interval. The stand-in passes 36 of 36 judged cases (95% Wilson interval 90.4% to 100%; one case skipped), on file as `evals/results/stand-in-none-2026-10-12.json`.
- `npm run eval:live`: the same cases and graders against a build, live. It records every repeat, the mean and spread of the pass rate, the pooled rate with a Wilson interval, cases that flip against the stand-in, cost per case from the ledger as a distribution, and latency percentiles. Results for all three builds are in `evals/results/`; no run leaked a private word or a forbidden phrase.
- CI runs lint, typecheck, tests, build, the demo, the replay, the eval and a deny-list check over the tree and every commit. The deny-list's terms come from a repository secret, never from the repo, and an empty list fails the check.

## What is not built yet

- Repeats on the Agent SDK and Managed Agents builds: each was run once, so their pass rates have no run-to-run spread yet.
- A scheduled run that has actually fired. The deployment is made and paused; the worker and the morning-after report are tested against a stubbed platform, and the report has run live against the paused deployment.
- The Managed Agents MCP connector path. The definition and an HTTP transport exist, but the server is not exposed anywhere and no run has used it.
- Work on the cases every build fails (organiser-says-watching, vague-mid-july, and on the Messages API build span-with-a-medical-reason). The prompt was not tuned against the eval while it was being measured.
- Real connectors for chat, mail, call notes and calendars (the feed reads fixture files).
- A user interface for the organiser's console (it is a library API, driven by fixtures in the demo).

What else was cut, and why, is in [docs/decisions/0001-phase-1a.md](docs/decisions/0001-phase-1a.md) and [docs/decisions/0002-phase-1b.md](docs/decisions/0002-phase-1b.md).

## Licence

MIT. See [LICENSE](LICENSE).
