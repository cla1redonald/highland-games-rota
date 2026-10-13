# Controls: the Agent SDK build

What stops this build doing something it should not, where each control lives, and the test that turns it red if it
is removed. Tests are in `packages/agent-sdk/test/sdk.test.ts` unless named otherwise.

| Control | What it does | File | Test |
| --- | --- | --- | --- |
| Deny by default | The session is given the rota server's eight tools, named in code, and no built-in tools (`tools: []`, and the built-ins refused by name as well). | `src/options.ts` | "offers only the eight rota tools, named in code, and loads no settings, skills, plugins or other servers" |
| No ambient configuration | No settings files, CLAUDE.md, skills, plugins or other MCP servers (`settingSources: []`, `skills: []`, `plugins: []`, `strictMcpConfig`). Its own config directory and home, and only PATH and the API key passed in. | `src/options.ts` | same test |
| No prompt anyone can answer yes | `permissionMode: 'dontAsk'` denies anything not pre-approved; `canUseTool` denies any tool that is not a rota tool. | `src/options.ts` | "denies any tool that is not a rota tool when asked" |
| Checked at run time | If the session's init message lists any tool beyond the eight, the tick stops. | `src/agent.ts` | "stops the tick if the session offers anything beyond the rota tools" |
| Pre-tool-use re-check | Every call is checked on its actual arguments before the MCP server sees it: allow-list, the server's own closed schema (a field such as `approved` or an approval id is refused here), then the engine's authority predicate against the store, read-only. | `src/hooks.ts`, `packages/agent-kit/src/guard.ts`, `packages/engine/src/authority.ts` | "refuses a forged approval in the arguments, and a decision with no approval, before the server sees either" |
| Same answer as the service | The hook's authority check is the function the service itself calls, so the two cannot drift. | `packages/engine/src/authority.ts`, `packages/engine/src/precheck.ts` | `packages/engine/test/precheck.test.ts` and `packages/agent-kit/test/guard.test.ts`: every adversarial case through both paths, identical refusals |
| Fails closed | A store that cannot be opened or read, or arguments the check cannot read, are a refusal. | `packages/engine/src/precheck.ts`, `packages/agent-kit/src/guard.ts` | "fails closed when the store cannot be read" (engine), "fails closed when the store cannot be opened or read" (kit) |
| Audit trail | Every hook decision (allow or deny, with the stage and refusal) and every result is appended to `audit.ndjson`, with a digest of the arguments and never the arguments themselves. | `src/hooks.ts`, `src/state.ts` | "writes an audit entry for every decision and every result, with digests, never the arguments" |
| Resumable by tick id | The session id is stored against the tick id as soon as the session starts; a tick that did not finish is resumed with `resume`. The call journal carries the record across the kill. | `src/agent.ts`, `src/state.ts` | "loses no decision the organiser made and carries none out twice" |
| No decision lost or repeated | Approvals live in the store and each is used once by the service, so a decision carried out before a kill is a no-op after it. | `packages/engine/src/authority.ts`, `packages/engine/src/service.ts` | same test: two approvals, two uses, across two processes |
| Turn ceiling | `maxTurns` on every run (default 24); hitting it is reported as `turn_limit`. | `src/options.ts`, `src/agent.ts` | "passes the turn and spend ceilings to every run and reports hitting them" |
| Spend ceiling per run | `maxBudgetUsd` on every run (default $2); hitting it is reported as `budget`. | `src/options.ts`, `src/agent.ts` | same test |
| Spend ceiling for the phase | Every assistant message's usage goes into the ledger once; the ledger refuses a new run past $60 and stops the process when a call passes it. | `src/agent.ts`, `packages/ledger/src/ledger.ts` | "records each assistant message once in the ledger, from its usage"; `packages/ledger/test/ledger.test.ts` |
| The run is always logged | If the session finishes without `log_run`, it is resumed once with a reminder. | `src/agent.ts` | "reminds the session once, by resuming it, if it finished without logging the run" |

What the SDK does that these tests do not exercise, because they replace `query()` with a fake: starting the Claude
Code process, connecting the stdio MCP server, the model loop itself, and the order in which it calls hooks. Those are
the SDK's, and a live run is the only test of them. The live run on 12 October 2026 (37 cases, Sonnet 5.5,
`evals/results/sdk-claude-sonnet-5-5-2026-10-12.json`) exercised all of them; it found one thing these tests had
assumed wrongly, that a hook receives a tool's result as content blocks (it is a plain string), now tested.
