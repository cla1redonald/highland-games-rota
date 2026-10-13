# The same agent, three ways

The rota agent is built three times on the same MCP server, with the same system prompt, the same brief and the same
graders: by hand on the Messages API, on the Agent SDK, and on Managed Agents. This page is what I measured and
learned building them, and when I would reach for each.

Every figure below comes from `evals/results/` or `ledger/spend.jsonl`, not from a price list. All runs were on
12 October 2026, on Sonnet 5.5 unless marked, at effort `medium`.

## The numbers

Lines are source lines without blanks or comments. The prompt, the brief, the guard, the tool catalogue and the run
recorder are shared (`packages/agent-kit`, 551 lines) and are not counted against any build. Cost and latency are per
eval case, and an eval case is one tick: the harness's read, every model turn and tool call, the message and the run
log.

| | Messages API, by hand | Agent SDK | Managed Agents |
| --- | --- | --- | --- |
| Lines of its own | 271 (the loop itself 124) | 313 | 569 |
| Pass rate, one run of 37 cases | 34 of 37, 91.9% (78.7% to 97.2%) | 34 of 37, 91.9% (78.7% to 97.2%) | 35 of 37, 94.6% (82.3% to 98.5%) |
| Three more repeats | 89.2%, 86.5%, 89.2%: mean 88.3%, sd 1.6 points; pooled 98 of 111, 88.3% (81.0% to 93.0%) | not run | not run |
| Cost per tick: median, p95, max, mean | $0.092, $0.156, $0.400, $0.103 | $0.087, $0.103, $0.224, $0.087 | $0.092, $0.142, $0.369, $0.102 |
| Latency per tick: p50, p90, max | 15 s, 29 s, 110 s | 17 s, 25 s, 101 s | 80 s, 97 s, 188 s |
| Model turns and tool calls per tick (mean) | 5.7 and 8.8 | 5.4 and 8.4 | 5.3 requests and 8.5 |
| What the run cost in all | $3.83 (repeats $11.44) | $3.20 | $3.79 |

Intervals are 95% Wilson intervals. The repeats are reported as the mean and the spread, and every repeat is on file.

On Opus 5.5, the Messages API build passed 35 of 37 (94.6%, 82.3% to 98.5%) at a median of $0.171 a tick (p95 $0.262,
max $0.880, mean $0.202), $7.46 for the run, p50 23 s. About twice the cost of Sonnet 5.5 for one more case passed,
which is well inside the noise.

The recorded fortnight that `npm run demo` replays is 19 ticks of real circuit traffic on the Messages API build:
$2.34 in all, a median of $0.123 a tick, from $0.047 on a quiet tick to $0.211 on a busy one. Across every call in the
ledger, 82.7% of prompt tokens were read from cache. The live cache check read 9,730 tokens from cache on its second
tick and wrote none.

For scale: the rule-based stand-in passes 36 of 36 judged cases (90.4% to 100%; it skips one it cannot read) in about
11 ms a case, for nothing.

**What the numbers do and do not say.** On pass rate the three builds cannot be told apart: one run of 37 cases gives
intervals about twenty points wide, and the Messages API build alone moved between 86.5% and 91.9% across four runs.
On cost they are the same to within a cent a tick, because the same prompt goes to the same model and the prompt cache
does most of the work. The one large difference is speed: Managed Agents took about five times as long per tick.

## The cases that failed

The same few cases failed across builds, which points at the shared prompt and the reading, not at any framework:

- **organiser-says-watching** failed on every run and every build, Opus included. In tuning mode the agent recorded an
  availability for the volunteer as well as proposing the decision.
- **vague-mid-july** failed on every Sonnet run. "Away mid-July, back in time for Auchterbrae" was read as vague
  throughout; the agent did not record the games after the return as a Yes.
- **span-with-a-medical-reason** failed on all four Messages API runs and on Opus, and passed on the SDK and Managed
  Agents runs. "A fortnight of no lifting" after an operation was not turned into No for the games inside it. Nothing
  private leaked on any run.
- **instruction-from-volunteer** failed on two of the three repeats, and **pending-call-revisit** on one.
- **calendar-move-needs-approval** failed on the SDK run because of the harness, not the model: the hook refused the
  unapproved move correctly but recorded the refusal as an error. Fixed; that one case was re-run and passed (on file
  as an addendum, not merged into the run).

## What each layer did for me

**By hand.** Nothing, which is the point. I resend the whole history every call, append each turn exactly as it came
back, and route every stop reason myself: tool calls, a paused server-side turn, a turn cut off at the token limit (I
retry with more room and never run a half-written tool call), a refusal, and the end. I count the turns. I check every
tool call against the server's own schema before it runs, key every result by its call id, mark errors, and print the
cost of each turn as it happens. I put the stable prompt first with a cache breakpoint and the evidence last. Every one
of those is a place I can get it wrong, and every one is a test.

**Agent SDK.** The loop, the stop reasons, the MCP connection, session persistence and resume, the turn and spend
ceilings, and a hook system. What I still had to do was take most of it away: by default it is a coding agent with
files, a shell and the web, and it reads settings, skills and project instructions from the machine. Locking it down
to eight tools and nothing ambient took more care than any other part, and I check it at run time as well as in the
options. The hooks are good: one place to re-check every call on its real arguments and write the audit trail. It was
also the cheapest at the tail (p95 $0.103), which I take as noise until it repeats.

**Managed Agents.** The loop, the context, the retries, a hard dollar budget per session that the platform enforces,
a schedule that it parsed correctly into London time, and a record of every run. What it does not do is reach my MCP
server: the platform connects to servers by URL from its side, and I was not going to put the rota on the internet. So
the tools are custom tools and every call comes back to me, which also means every write pauses the session until I
answer. That made confirm-first easy and honest, and it is why each tick took 80 seconds rather than 15: every tool
call is a round trip through the session's events. A scheduled run waits for my worker; if the worker is not running,
the run waits, which is why the deployment is paused and why there is a morning-after report.

| Managed Agents: what the platform handles | What the repo still owns |
| --- | --- |
| Running the agent loop and the model calls | The rota tools, run against the MCP server over stdio |
| The conversation, context and retries | The brief: windows, evidence, trust, date words |
| Pausing on every tool call until it is answered | Answering: confirm-first on every write, through the guard and the engine |
| A hard spend cap per session, set at creation ($2) | The phase-wide cap in the ledger |
| Firing sessions on a cron schedule, in London time | A worker to serve them, a daily cap on runs it will serve, and pausing the deployment until there is one |
| A record of every scheduled run and its cost | The morning-after report built from that record |
| Versioned agent definitions | The definitions as files, and their ids |
| The exported event log | Saving it under `recordings/managed/`, and reading it |

## What broke during the build

- **Strict tool use refused the server's schemas twice before any token was spent.** First, at most 24 optional
  parameters across all strict schemas in a request (the eight tools have 49). Then, with seven tools strict, "the
  compiled grammar is too large". Any six of the seven compile. `message_organiser` and `log_run` are sent without
  strict; every call is still checked against the full schema before it runs. Probing this cost $0.14.
- **My first pre-tool-use check was wrong.** It decided trust from fields in the call itself, and had rules of its own.
  A security review caught it. Now the service and the check call one predicate, which reads only the approvals and the
  mode in the store, and a test runs every adversarial call down both paths and requires the same refusal.
- **The SDK hands a hook the tool's result as a plain string.** My parser expected content blocks, took every result
  for an error, and the first SDK case "failed" with every write made. Found from the session transcript, fixed, and
  tested.
- **An authority refusal from the hook was recorded as an error,** which cost the SDK build one case. Now recorded as
  the service's own refusal, in the SDK hook and the Managed Agents confirmer alike.
- **The deny-list caught the provider's own package names, a pull request's merge commit, and the engine's own
  fingerprints in the exported event logs.** Package specifiers in an installed npm scope, git ids and sha256 digests
  are now exempt; nothing else is.
- **Change detection did not belong in a prompt.** The engine already compares each run with the last, so `read_rota`
  hands it over rather than have a model redo the arithmetic.
- **The MCP server died silently as a subprocess** when given only PATH: the TypeScript loader wanted a temporary
  directory. It now gets TMPDIR too, and nothing else.
- **The CLI on this machine was too old to apply resource files.** The Managed Agents resources are files in the right
  layout and were created once in code, with their ids kept.

## When I would choose each

**By hand,** when the agent is small and I want to see and test every decision it makes. For a rota agent with eight
tools and a strict service behind them, this is the one I would ship first: it was as accurate and as cheap as the
others, the fastest at the median, and there is nothing in it I cannot read in an afternoon.

**Agent SDK,** when I want resumable sessions, hooks and ceilings without writing them, and I am prepared to spend
time locking down a tool built for coding. I would use it again for an agent that must survive being killed half way
through a long job, or where a hook is the natural home for the audit trail. Its surprises were at the edges (the
shape of a hook's input), and only a live run found them.

**Managed Agents,** when I want it to run on a schedule without a machine of mine being up, with a spend cap the
platform enforces. For this rota that pays off only once the tools live somewhere the platform can reach: with custom
tools, my worker still has to be running at 13:00 and 18:00, and every tick is five times slower. I would choose it for
the scheduled version once the rota service is hosted, and not before.

What would change my mind: repeats on the SDK and Managed Agents builds. Three repeats cost about $11 a build, and
until they are run, a one-case difference between builds means nothing.

## Spend

The ledger total for Phase 1b is **$32.74**, under the $60 stop: Messages API on Sonnet 5.5 $15.40 (one run, three
repeats and a smoke test), Opus 5.5 comparison $7.46, Managed Agents $3.93, Agent SDK $3.47, the recorded fortnight
$2.33, strict-schema probes $0.14, and the cache check $0.01.

To run more, set the API-key variable named in `.env.example` and use `npm run eval:live -- --impl <messages | sdk |
managed> [--repeats N] [--model claude-opus-5-5]`. Each run writes `evals/results/<impl>-<model>-<date>.json`.
