# Controls: the Agent SDK build

This page lists the controls that stop the Agent SDK build from doing anything it should not. Each row gives the file
the control lives in and the test that fails if it is taken out. The tests are in `packages/agent-sdk/test/sdk.test.ts`
unless another file is named.

| Control | What it does | File | Test |
| --- | --- | --- | --- |
| Deny by default | The session gets the rota server's eight tools, named in code, and no built-in tools (`tools: []`, and the built-ins refused by name as well). | `src/options.ts` | "offers only the eight rota tools, named in code, and loads no settings, skills, plugins or other servers" |
| Nothing read from the machine | No settings files, CLAUDE.md, skills, plugins or other MCP servers (`settingSources: []`, `skills: []`, `plugins: []`, `strictMcpConfig`). It has its own config directory and home, and is passed only PATH and the API key. | `src/options.ts` | same test |
| No permission prompts | `permissionMode: 'dontAsk'` denies anything not approved in advance, and `canUseTool` denies any tool that is not a rota tool. | `src/options.ts` | "denies any tool that is not a rota tool when asked" |
| Checked at run time | The tick stops if the session's init message lists any tool beyond the eight. | `src/agent.ts` | "stops the tick if the session offers anything beyond the rota tools" |
| Pre-tool-use re-check | Every call is checked on its actual arguments before the MCP server sees it. It goes through the allow-list first, then the server's own closed schema (which refuses a field such as `approved` or an approval id), then the engine's authority predicate, which reads the store and never writes to it. | `src/hooks.ts`, `packages/agent-kit/src/guard.ts`, `packages/engine/src/authority.ts` | "refuses a forged approval in the arguments, and a decision with no approval, before the server sees either" |
| Same answer as the service | The hook's authority check is the function the service itself calls, so the two cannot drift. | `packages/engine/src/authority.ts`, `packages/engine/src/precheck.ts` | `packages/engine/test/precheck.test.ts` and `packages/agent-kit/test/guard.test.ts`: every adversarial case through both paths, identical refusals |
| Fails closed | If the store cannot be opened or read, or the check cannot read the arguments, the call is refused. | `packages/engine/src/precheck.ts`, `packages/agent-kit/src/guard.ts` | "fails closed when the store cannot be read" (engine), "fails closed when the store cannot be opened or read" (kit) |
| Audit trail | Every hook decision (allow or deny, with the stage and refusal) and every result is appended to `audit.ndjson`, with a digest of the arguments and never the arguments themselves. | `src/hooks.ts`, `src/state.ts` | "writes an audit entry for every decision and every result, with digests, never the arguments" |
| Resumable by tick id | The session id is stored against the tick id as soon as the session starts, and a tick that did not finish is resumed with `resume`. The call journal keeps the record intact across the kill. | `src/agent.ts`, `src/state.ts` | "loses no decision the organiser made and carries none out twice" |
| No decision lost or repeated | Approvals live in the store and the service uses each one once, so a decision carried out before a kill does nothing when it comes round again. | `packages/engine/src/authority.ts`, `packages/engine/src/service.ts` | same test: two approvals, two uses, across two processes |
| Turn ceiling | Every run has `maxTurns` (default 24), and hitting it is reported as `turn_limit`. | `src/options.ts`, `src/agent.ts` | "passes the turn and spend ceilings to every run and reports hitting them" |
| Spend ceiling per run | Every run has `maxBudgetUsd` (default $2), and hitting it is reported as `budget`. | `src/options.ts`, `src/agent.ts` | same test |
| Spend ceiling for the phase | The usage from each assistant message goes into the ledger once. The ledger refuses to start a new run once $60 is spent, and stops the process when a call takes the total past it. | `src/agent.ts`, `packages/ledger/src/ledger.ts` | "records each assistant message once in the ledger, from its usage"; `packages/ledger/test/ledger.test.ts` |
| The run is always logged | A session that finishes without calling `log_run` is resumed once with a reminder. | `src/agent.ts` | "reminds the session once, by resuming it, if it finished without logging the run" |

These tests swap `query()` for a fake, so some of what the SDK does is never exercised here. That means starting the
Claude Code process, connecting the stdio MCP server, the model loop itself and the order in which hooks are called.
Those parts belong to the SDK, and only a live run tests them. The live run on 12 October 2026 (37 cases, Sonnet 5.5,
`evals/results/sdk-claude-sonnet-5-5-2026-10-12.json`) went through all of them. It showed that these tests had made one
wrong assumption. A hook receives a tool's result as a plain string, and the tests had assumed content blocks. There
is now a test for the string.
