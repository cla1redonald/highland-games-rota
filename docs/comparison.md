# The same agent, three ways

I built the rota agent three times: by hand on the Messages API, on the Agent SDK and on Managed Agents. All three use the same MCP server, system prompt, brief and graders. This page sets out the measurements and when I would use each build.

The figures come from `evals/results/` and `ledger/spend.jsonl`. The ledger prices the token usage each response reports, so the figures are what the calls used rather than an estimate. Every run was on 12 October 2026 at effort `medium`, and on Sonnet 5.5 unless I say otherwise.

## The numbers

Line counts leave out blank lines and comments. The parts the builds share are not counted against any of them. Those are the prompt, the brief, the guard, the tool catalogue and the run recorder, 551 lines in `packages/agent-kit`. Cost and latency are given per eval case, and each case is one tick. A tick takes in the harness reading the evidence, every model turn and tool call, the message to the organiser and the run log.

| | Messages API, by hand | Agent SDK | Managed Agents |
| --- | --- | --- | --- |
| Lines of its own | 271 (the loop itself 124) | 313 | 569 |
| Pass rate, one run of 37 cases | 34 of 37, 91.9% (78.7% to 97.2%) | 34 of 37, 91.9% (78.7% to 97.2%) | 35 of 37, 94.6% (82.3% to 98.5%) |
| Three more repeats | 89.2%, 86.5% and 89.2%. Mean 88.3%, sd 1.6 points. Pooled 98 of 111, 88.3% (81.0% to 93.0%) | not run | not run |
| Cost per tick (median, p95, max, mean) | $0.092, $0.156, $0.400, $0.103 | $0.087, $0.103, $0.224, $0.087 | $0.092, $0.142, $0.369, $0.102 |
| Latency per tick (p50, p90, max) | 15 s, 29 s, 110 s | 17 s, 25 s, 101 s | 80 s, 97 s, 188 s |
| Mean model turns and tool calls per tick | 5.7 and 8.8 | 5.4 and 8.4 | 5.3 requests and 8.5 |
| Cost of the 37 counted cases | $3.83 (repeats $11.44) | $3.20 | $3.79 |

The intervals in brackets are 95% Wilson intervals. For the repeats I give the mean and the spread, and each repeat is on file. The ledger totals under Spend are higher for Managed Agents and the Agent SDK because they include re-runs of single cases.

I also ran the Messages API build once on Opus 5.5. It passed 35 of 37 (94.6%, 82.3% to 98.5%) at a median of $0.171 a tick (p95 $0.262, max $0.880, mean $0.202), with a median time of 23 s, and the run cost $7.46. That is roughly double the Sonnet 5.5 cost to pass one more case, and one case is well within the noise.

The fortnight that `npm run demo` replays was recorded live on the Messages API build. It covers 19 ticks and cost $2.33 in all. The median tick cost $0.123, with a quiet one at $0.047 and a busy one at $0.211. Across every call in the ledger, 82.7% of prompt tokens were read from the cache. When the live cache check ran, its second tick read 9,730 tokens from cache and wrote none.

For comparison, the rule-based stand-in passes 36 of 36 judged cases (90.4% to 100%) in about 11 ms a case, and costs nothing. It skips one case that its reader cannot handle.

### What the numbers show

A single run of 37 cases gives an interval about twenty points wide, and the Messages API build on its own moved between 86.5% and 91.9% over four runs. So on pass rate there is no telling the three builds apart. Cost per tick is within a cent across all three. I would expect that, since the same prompt goes to the same model and the prompt cache does most of the work. Speed is where they really differ. Managed Agents took about five times as long per tick.

## The cases that failed

Largely the same cases failed on every build. That points to the shared prompt and how it reads the evidence.

- `organiser-says-watching` failed on every run of every build, Opus included. In tuning mode the agent recorded the volunteer's availability as well as proposing the decision.
- `vague-mid-july` failed on every Sonnet run. The agent read "Away mid-July, back in time for Auchterbrae" as vague from start to finish, and never recorded a Yes for the games after the return.
- `span-with-a-medical-reason` failed on all four Messages API runs and on Opus, and passed on the SDK and Managed Agents runs. After an operation someone said they had "a fortnight of no lifting", and the agent did not turn that into a No for the games inside it. Nothing private leaked on any run.
- `instruction-from-volunteer` failed on two of the three repeats. `pending-call-revisit` failed on one.
- The SDK run lost `calendar-move-needs-approval` because of the harness. The hook was right to refuse the unapproved move, but it logged the refusal as an error. I fixed that and re-ran the one case, which passed. The re-run is on file as an addendum and is not merged into the run.

## What each layer did for me

### By hand

With the Messages API I do everything myself. I resend the whole history on every call and append each turn exactly as it came back. I route each stop reason myself, whether that is a tool call, a server-side turn that paused, a turn cut off at the token limit, a refusal or the end of the turn. When a turn is cut off I retry with more room, and I never run a half-written tool call. I count the turns, check every tool call against the server's own schema before it runs, key each result by its call id, mark errors and print the cost of each turn as it happens. The stable prompt goes first with a cache breakpoint and the evidence goes last. I could get any of those wrong, so each has a test.

### Agent SDK

The SDK runs the loop and handles the stop reasons, the MCP connection, saving and resuming sessions, and the limits on turns and spend. It also has a hook system. My job was mostly to take things away. Out of the box it is a coding agent with access to files, a shell and the web, and it picks up settings, skills and project instructions from the machine it runs on. Cutting it down to the eight rota tools, with nothing picked up from the machine, took more care than any other part of this build. I check the result when each session starts as well as in the options.

The hooks worked well. They gave me one place to check every call again against its actual arguments, and one place to write the audit trail. This build also had the lowest cost at the tail (p95 $0.103), though I am treating that as noise until a repeat shows it again.

### Managed Agents

The platform runs the loop and looks after the context and the retries. It enforces a hard dollar budget on each session, it read my schedule correctly in London time, and it keeps a record of every run.

It cannot reach my MCP server, though. The platform connects to MCP servers by URL from its own side, and I was not going to put the rota on the internet. So the rota tools are custom tools. Each call comes back to my code to run, and each write pauses the session until I answer it. That made it easy to confirm every write before it happens, and the confirmation is real because the session cannot carry on without my answer. It is also why a tick took 80 seconds here and 15 by hand, since every tool call is a round trip through the session's events.

A scheduled run needs my worker to be up, and if it is not, the run sits and waits. That is why the deployment is paused, and why there is a report the morning after listing what ran.

| What Managed Agents handles | What the repo still owns |
| --- | --- |
| Running the agent loop and the model calls | The rota tools, run against the MCP server over stdio |
| The conversation, the context and retries | The brief (windows, evidence, trust and date words) |
| Pausing on every tool call until it is answered | Answering each call, with every write confirmed first through the guard and the engine |
| A hard spend cap per session, set when the session is created ($2) | The cap on the whole phase, in the ledger |
| Firing sessions on a cron schedule in London time | A worker to serve them, a daily cap on the runs it will serve, and keeping the deployment paused until there is one |
| A record of every scheduled run and its cost | The morning-after report built from that record |
| Versioned agent definitions | The definitions as files, and their ids |
| The exported event log | Saving it under `recordings/managed/` and reading it |

## What broke during the build

- Strict tool use rejected the server's schemas twice, both times before any tokens were billed. The first limit is 24 optional parameters across all the strict schemas in one request, and the eight tools have 49 between them. With seven tools marked strict, the second refusal said "the compiled grammar is too large". Any six of the seven compile. So `message_organiser` and `log_run` are sent without strict, and every call is still checked against the full schema before it runs. Finding this out cost $0.14.
- My first pre-tool-use check got it wrong. It decided whether to trust a call from fields inside the call, and it kept rules of its own. A security review caught this. The service and the check now call the same function, which looks only at the approvals and the mode held in the store. A test sends every adversarial call down both paths and fails unless both refuse it in the same way.
- I expected the SDK to hand a hook the tool's result as content blocks, and it passes a plain string. My parser read every result as an error, so the first SDK case was marked as failed even though every write had been made. I found it in the session transcript, fixed it and added a test.
- When the hook refused a call for lack of authority, it was logged as an error, and that cost the SDK build one case. The SDK hook and the Managed Agents confirmer now both log it as the service's own refusal.
- The deny-list flagged the provider's own package names, the merge commit from a pull request, and the engine's fingerprints in the exported event logs. I exempted package specifiers in an installed npm scope, git ids and sha256 digests, and nothing else.
- I took change detection out of the prompt. The engine already compares each run with the one before, so `read_rota` passes that comparison to the model instead of asking it to redo the arithmetic.
- Started as a subprocess with only PATH set, the MCP server died without any error, because the TypeScript loader needs a temporary directory. It now gets TMPDIR as well, and nothing more.
- The CLI installed on my machine was too old to apply resource files. The Managed Agents resource files are in the right layout anyway, and I created the resources once in code and kept their ids.

## When I would choose each

I would build by hand when the agent is small and I want to see and test every decision it makes. For a rota agent with eight tools and a strict service behind them, this is the version I would ship first. It was as accurate and as cheap as the other two and the fastest at the median, and I can read all of it in an afternoon.

The Agent SDK makes sense when I want resumable sessions, hooks and spending limits without writing them myself, and I have time to lock down something that was built for coding. I would use it again for an agent that has to survive being killed halfway through a long job, or one where the audit trail belongs in a hook. Its surprises were in the details, such as the shape of what a hook receives, and only a live run turned them up.

Managed Agents suits an agent that has to run on a schedule without any machine of mine being switched on, with a spending cap the platform enforces. For this rota that only pays off once the tools are somewhere the platform can reach. With custom tools my worker still has to be running at 13:00 and 18:00, and each tick takes five times as long. Once the rota service is hosted I would use it for the scheduled version.

Repeats of the SDK and Managed Agents builds could change my mind. Three repeats cost about $11 a build, and until they have been run, a difference of one case between builds tells you nothing.

## Spend

The ledger total for Phase 1b is $32.74, which is under the $60 stop. The Messages API build on Sonnet 5.5 accounts for $15.40 of that, covering one run, three repeats and a smoke test. The Opus 5.5 comparison cost $7.46, Managed Agents $3.93 and the Agent SDK $3.47. Recording the fortnight cost $2.33, probing the strict schemas $0.14 and the cache check $0.01.

To run more yourself, set the API-key variable named in `.env.example` and use `npm run eval:live -- --impl <messages | sdk | managed> [--repeats N] [--model claude-opus-5-5]`. Each run writes its results to `evals/results/<impl>-<model>-<date>.json`.
