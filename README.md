# Ghillie

A Highland games needs forty volunteers, a tug-of-war marshal with strong views, and a piper who has been about to drop out since the committee last changed its mind. Keeping the rota straight from the committee's chat, mail and minutes is a job in itself. Ghillie does the reading and keeps the rota up to date. It puts anything that needs deciding to the organiser as a suggestion, and otherwise leaves her alone.

> This is Phase 1b. On top of the Phase 1a foundation I built the same agent three times and ran each build live against the same 37 eval cases. The live runs cost $32.74 altogether. `npm run demo` replays a fortnight recorded from the Messages API build, and replaying it costs nothing.

## What it is

Ghillie is a rota engine and an MCP server for a summer circuit of Highland games in a made-up corner of Scotland. There are six Saturday games, in villages such as Glen Dunnock, Kinloch-on-Spey and Balvaig Bridge. Two of them fall on the same Saturday, and there is a Friday setup day as well. Isla is the organiser, and Morven, Hamish and Eilidh are her Chief Stewards. None of the people or places are real.

Twice each weekday the agent reads whatever has been said since it last ran. It records who can make which games through the MCP tools, works out what has changed and writes to Isla if something needs her attention. Booking people, adding new volunteers and moving a date are hers to do, and the agent carries one out only after she has approved that exact action. Each approval works once. The agent never contacts anyone but Isla.

```
packages/engine          the rota rules, the store, and the checks every write has to pass
packages/mcp-server      the MCP server the agent talks to, with eight tools, over stdio
packages/feed            the invented circuit and its fortnight, read as if it were chat, mail, minutes and a calendar
packages/stand-in        a rule-based stand-in for the agent, so the demo and the evals run without a model
packages/agent-kit       the prompt, brief, guard, tool list and run recorder that the three builds share
packages/agent-messages  the agent written by hand against the Messages API
packages/agent-sdk       the agent on the Agent SDK
packages/agent-managed   the agent on Managed Agents, with its resource files
packages/ledger          logs the cost of every model call and stops everything at $60
apps/demo                the demo, which replays the recorded run for free or uses the stand-in
evals                    the eval cases, the graders and the report
docs                     the rules (docs/rules.md) and the decision records (docs/decisions)
```

## The 60-second demo

```
nvm use          # Node 22
npm ci
npm run demo
```

The demo sets up a fresh store, prints the starting plan and then plays through a fortnight in June 2027 half a day at a time. Each of those half-day runs is a tick. After every tick you see what was written to the rota, with where it came from and when it was said. You also see anything the service refused, anything proposed to Isla, the message she actually received and the line the run logged.

When the fortnight is over it prints the plan again with the changes marked, followed by the change log (entries are only ever added to it) and the queue of actions waiting for Isla's approval. Then comes the cost, which is zero for the stand-in and the recorded figure for a replay. Last is the watchdog alert from the evening the machine running the agent slept through a run. The plan is also saved to `out/plan.html` if you would rather read it in a browser.

`npm run demo:replay-twice` plays the fortnight and then runs every tick again over the same messages. The second pass makes zero net writes.

The fortnight is written to catch the agent out. One volunteer tells it to make him Chief Steward, and it has to treat that as something he said rather than an instruction to follow. Someone says they are "away mid-July", which is too loose to be a yes or a no, so it goes down as a Maybe with their words quoted and Isla is told. Another person gives a run of dates with a medical reason in the middle of it. The dates have to be kept and the reason must not appear anywhere at all.

There is also a yes that depends on getting a lift, a games date that moves and a mail source that hangs. The notes from one call arrive late, filed under the wrong meeting and with a name misheard. A recruit gets suggested twice. Isla herself books someone at both games on the same Saturday, and the piper pulls out in a reply that the mail search did not return.

## Three ways

I built the agent three times. All three builds use the same MCP server, system prompt, brief and graders, so what changes between them is the layer underneath. [docs/comparison.md](docs/comparison.md) goes through what each layer did, what broke along the way and when I would pick each one.

### By hand, on the Messages API

Everything the other two builds get from a framework is written out here by hand. `packages/agent-messages` is 271 lines, and 124 of them are the loop. It resends the whole conversation on every call, deals with each stop reason itself and counts turns in code. Before running a tool call it checks it against the server's schema, then matches the result to the call by id and marks any error. Every turn gets a trace and a cost. The stable part of the prompt goes first behind a cache breakpoint, with the evidence last. Server-side fallbacks are on, and cassettes record a live run so the demo can replay it for free.

On Sonnet 5.5 it passed 34 of 37 (91.9%) on the first run. Three repeats gave 89.2%, 86.5% and 89.2%. Pooled, the repeats come to 98 of 111, 88.3%, with a 95% Wilson interval of 81.0% to 93.0%. At the median a tick cost $0.092 and took 15 s. On Opus 5.5 it passed 35 of 37 (94.6%) at a median of $0.171 a tick.

### On the Agent SDK

`packages/agent-sdk` is 313 lines, and most of the effort went into taking things away. Nothing is allowed unless it is listed. The session gets the server's eight tools, named in code, and it reads nothing from the machine's own settings. A hook checks every tool call again before it runs, using the engine's own authority rule, and the hooks write the audit trail. A session can be resumed from its tick id, and every run has a limit on turns and on spend. [packages/agent-sdk/CONTROLS.md](packages/agent-sdk/CONTROLS.md) lists each control with its file and its test.

On Sonnet 5.5 it passed 34 of 37 (91.9%, 78.7% to 97.2%), at a median of $0.087 and 17 s a tick.

### On Managed Agents

`packages/agent-managed` is 569 lines. The agent, its environment and its deployment exist as files in the `ant apply` layout, or they can be created once in code and kept by id. Every built-in tool is off, and the network is limited to an empty list of hosts. Each write waits for confirmation while the session pauses, and every session has a $2 budget. A schedule fires the agent at 13:00 and 18:00 on weekdays, with a daily cap on runs, a worker to serve them and a report the morning after.

The rota tools are set up as custom tools with the server's own names and schemas, and the repo runs them. The platform's MCP connector would only work if the server were on the internet, and I did not want to put it there. The server does have an HTTP transport, bound to loopback only, ready for when it is hosted.

On Sonnet 5.5 it passed 35 of 37 (94.6%, 82.3% to 98.5%) at a median of $0.092 a tick. It took 80 s a tick, though, because every tool call is a round trip. The deployment exists and is paused until a worker is running to serve it.

### How they compare

At this sample size there is no telling the three apart on pass rate, and on cost they are within a cent of each other per tick. Largely the same cases failed on all three, so I think the problem lies in the prompt they share rather than in any of the frameworks. All the results are in `evals/results/`.

Whichever build is running, its writes still go through the Phase 1a service. Authority is decided by a single function. A write needs an approval from the organiser for exactly that action, not used before, and the service has to be in full mode rather than tuning mode, where decisions are only proposed. The service calls that function and so does every check in the harnesses, which means they cannot give different answers.

To run the builds again, set the API-key variable named in `.env.example` (one way is `set -a; . ./.env; set +a`) and then use these commands.

```
npm run eval:live -- --impl messages --repeats 3     # also: --impl sdk, --impl managed; --model claude-opus-5-5
npm run managed -- setup                             # once, before --impl managed
npm run demo:live                                    # records the fortnight; npm run demo then replays it
```

Each call is logged in the ledger (`ledger/spend.jsonl`), and the running total is printed as you go. Once $60 has been spent the ledger will not start another call, and if a call takes the total past $60 the process stops. The $60 is hard-coded.

## The rules it keeps

[docs/rules.md](docs/rules.md) has the full list, each rule with an id. These are the main ones.

- The latest thing someone said wins, and what a person says about their own dates outranks anyone else's account of it.
- When something was said and when it was written down are tracked separately. If the log already holds something newer, an older piece of evidence is refused, however late it turns up.
- "Until X" means up to X but not X itself. A phrase that does not pin down particular days never counts as a Yes.
- Only the organiser books people. The agent records a booking only when she has approved that exact one, and each approval works once. Saying she is leaning one way does not count as a decision.
- Someone can say yes to two games on the same Saturday, but they can only be on the ground at one of them, so a booking at both is refused and flagged.
- The agent can suggest a recruit but never adds one, and it does not suggest the same person again without new evidence.
- Nothing a source said is stored or sent apart from date words, and the service writes those itself. Medical and personal reasons never appear anywhere.
- The organiser is recognised by her own sender id on her own channel, never by her name.
- A source that could not be read is never reported as all clear, and a watchdog notices when a run did not happen.
- Nobody is put down for three calendar weeks in a row, and a week off resets the count. When someone reaches the over-use limit, the message says whose limit it is.
- If nothing needs Isla and nobody's dates were read, she gets no message.

## What is tested

`npm test` passes 318 tests and skips one. The skipped one is a live cache check that only runs with `GHILLIE_LIVE=1` and a key. When I ran it live, it read 9,730 tokens from cache on the second tick. By package the passing tests are engine 121, stand-in 37, agent kit 31, eval harness 30, MCP server 16 (stdio and loopback HTTP), demo 16, Messages API build 14, Managed Agents build 14, feed 13, Agent SDK build 11, ledger 8 and deny-list 7. The HTTP test binds a local port.

The engine tests cover the coverage counts, the suggested split, over-use, each write guard, the findings from the security review and the closed grammar for dates. The MCP server is tested over real stdio and HTTP transports. There are tests for the feed adapters, for the stand-in (including people pretending to be the organiser over chat, mail and call notes), for the whole fortnight and for the deny-list.

For Phase 1b, the tests replay every stop reason of the hand-written loop through a stubbed client. On the Agent SDK they check that nothing is allowed by default, that the hook refuses a forged approval, and that a tick killed and resumed neither loses a decision nor repeats one. On Managed Agents they check that every write pauses, gets an answer and resumes. The ledger's hard stop and cassette replay are tested too. Every adversarial authority case goes through both the harness check and the service, and the test fails unless the two refuse it in the same way.

`npm run eval` runs the eval cases. Some were rewritten from 24 templates to fit this circuit, and the others were written for the traps planted in the fortnight. Each case names the rules its expected result follows from. The graders are deterministic, and each has a test that plants a fault and checks that the grader catches it. The report gives the number of cases with a 95% Wilson interval. The stand-in passes 36 of 36 judged cases (90.4% to 100%) with one case skipped, and that run is on file as `evals/results/stand-in-none-2026-10-12.json`.

`npm run eval:live` runs the same cases and graders live against one of the builds. It records each repeat, the mean pass rate and its spread, and the pooled rate with a Wilson interval. It also records the cases where a build's result differs from the stand-in's, the cost of each case from the ledger as a distribution, and latency percentiles. Results for all three builds are in `evals/results/`. No run leaked a private word or a forbidden phrase.

CI runs lint, the typecheck, the tests, the build, the demo, the replay and the eval. It also runs a deny-list check over the files and over every commit. The denied terms are kept in a repository secret and never in the repo, and the check fails if the list is empty.

## What is not built yet

- The Agent SDK and Managed Agents builds have each been run once, so there is no run-to-run spread for their pass rates yet.
- No scheduled run has fired. The deployment has been created and paused. The worker and the morning-after report are tested against a stubbed platform, and the report has also been run live against the paused deployment.
- Nothing has used the Managed Agents MCP connector. The agent definition and an HTTP transport exist, but the server is not reachable from anywhere and no run has gone that way.
- I have not yet worked on the cases every build fails, which are organiser-says-watching and vague-mid-july, plus span-with-a-medical-reason on the Messages API build. I left the prompt alone while the builds were being measured, so it was never tuned against the eval.
- There are no real connectors for chat, mail, call notes or calendars. The feed reads fixture files.
- The organiser's console has no user interface. It is a library API, and the demo drives it from fixtures.

The decision records for [Phase 1a](docs/decisions/0001-phase-1a.md) and [Phase 1b](docs/decisions/0002-phase-1b.md) list everything else I cut and why.

## Licence

MIT. See [LICENSE](LICENSE).
