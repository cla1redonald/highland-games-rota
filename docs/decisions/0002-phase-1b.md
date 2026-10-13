# 0002: Phase 1b, the same agent three ways

Status: accepted. Date: October 2026.

Phase 1b builds the rota agent three ways, all on the Phase 1a MCP server: a hand-written Messages API loop, an Agent
SDK build and a Managed Agents build. It adds a cost ledger with a hard stop, a live eval runner, cassettes for a free
demo, and a comparison. This record lists what was decided where the brief was silent, impossible or contradictory,
and what could not be done.

## How the live runs went

1. **The build was done before any key was available, then run live.** When the code was written there was no API key
   in the environment and the CLI's saved sign-in had expired with no refresh token ("user_oauth credentials ... has
   client_id in config but missing refresh_token"), so everything was first tested against stubs. A key was then
   supplied for the live runs, loaded into each command's environment only, never written to a file in this repo.
   All results are in `evals/results/`; the ledger is `ledger/spend.jsonl`; the total is $32.74.
2. **The hard stop was lowered from $100 to $60,** and the runs were done in a fixed order of priority, because the
   organisation's monthly limit is shared with other work: the Messages API build once, its three repeats, the Agent
   SDK build once, Managed Agents once, the recorded fortnight, and an Opus 5.5 comparison only if the total was still
   under $40 (it was $25.28).
3. **Managed Agents is open to this account.** The agent, environment and deployment were created in code; the platform
   parsed the weekday schedule as 12:00 and 17:00 UTC (13:00 and 18:00 in London). The deployment was paused as soon as
   it was made, since a fired run waits for a worker and none is kept running. Its ids are in
   `packages/agent-managed/resources/ids.json`.
4. **`ant apply` could not be used.** The installed CLI is 1.10.0; applying resource files needs 1.30.0 or later. The
   resources are written in the `ant apply` layout anyway (`packages/agent-managed/resources/`), and
   `npm run managed -- setup` either prints the `ant apply` command (a newer CLI) or creates each resource once in code
   and keeps its id. Applying is the owner's decision, not the harness's.

## Contradictions and impossibilities, and the simpler option taken

5. **The deny-list and the provider's packages.** The deny-list denies the provider's name, and Phase 1b has to depend
   on two packages in the provider's npm scope. A package specifier (`@scope/name`), and the bin entry the lockfile
   records for it, are now exempt when, and only when, that scope is an installed dependency in `package-lock.json`.
   The bare word stays denied everywhere else, so code imports the API client under a neutral local name and the docs
   say "the provider". The API-key variable is named once, in `.env.example`, and read from there.
6. **Whose voice the comparison is in.** The brief asks for the author's own framing. It is written in the first
   person, and names nobody.
7. **The commit trailer.** The brief asks for a co-author trailer naming one model, unless standing instructions say
   to name the model that did the work. They do, so the commits name Claude Opus 5.5. History mode already exempts
   trailers.
8. **Managed Agents and a local MCP server.** The platform's MCP connector connects to servers by URL from its own
   side. A server on this machine would have to be made reachable from the internet (a public tunnel to a store with
   the circuit's data), and the evals need a fresh store per case. Neither fits a recorded run on a laptop, so the
   brief's fallback is taken: **the rota tools are Managed Agents custom tools with the server's own names and
   schemas**, executed by the repo against the same MCP server over stdio. The difference: in this path the platform
   never touches the server; every tool call pauses the session until the repo answers; confirm-first is the repo's
   guard answering before it runs a write. A thin Streamable HTTP transport was still added to the server (loopback
   only, a bearer token on every request, stateless, off unless `GHILLIE_HTTP_PORT` is set), and the agent
   definition has an `mcp` mode with every write tool on `always_ask`, so the connector path is one public URL away.
   It was not used for any run. The research-preview MCP tunnels API in the SDK was not used either: the skill does
   not document it, and it needs a connector process and certificates.
9. **Scheduled runs have no brief.** A deployment fires a session with a fixed opening message, so it cannot carry the
   tick's evidence. The managed agent has one extra custom tool, `gather_evidence`, that returns the same brief the
   other builds are given. The worker that answers scheduled sessions also serves that tool. The rota server keeps its
   eight tools.
10. **Strict tool use and the server's schemas.** The server's schemas use constraints strict tool use does not accept:
   string lengths, item counts, numeric bounds, patterns, tuples and objects keyed by an enum. The API is sent a strict
   copy with those removed or rewritten as plain shapes; every call is still validated against the server's full schema
   before it runs. The strict copy only ever loosens, and is deterministic, so it never breaks the prompt cache. Live,
   the API refused more: at most 24 optional parameters across all strict schemas in a request (the eight tools have
   49), and with seven tools strict "the compiled grammar is too large", though any six compile. `message_organiser`
   (26 optional parameters on its own) and `log_run` (its fields are copied from the brief) are sent without strict.
   Both refusals came before any token was billed; probing the combinations cost $0.14.
11. **The organiser's identity "injected by the harness".** The harness names the organiser from configuration and marks
   which evidence came from her own channel (her sender id on her direct-message channel, decided by the feed
   adapters). No tool takes an identity, so there is nothing for the model to supply. An earlier version also checked
   `saidBy` against trusted evidence in the guard; see 12.

## Decisions taken in review

12. **One authority predicate.** A security review of the first pre-tool-use check found it read trust from the call
    itself (`saidBy`, `source`, `evidenceAt`) and kept rules of its own. Now `authorise()` in
    `packages/engine/src/authority.ts` is the only place authority is decided. It reads the approvals ledger (a grant
    for exactly this action's fingerprint, neither used nor declined) and the mode held in the store, and nothing
    else. The service calls it at the moment of a write; `precheckCall()` calls it before a call reaches the service.
    The call's arguments only name the action. A forged approval id, a replayed approval, an approval for a different
    action, and a used or withdrawn approval all fail the same way, because a grant can only be found by recomputing
    the action's fingerprint.
13. **Fields that would carry authority are refused by the schema, before the precheck runs.** Every tool's schema is
    closed, and the harness guard validates against it first: `approved`, `actor`, `approver`, `mode`, an approval id or
    a `to` is refused there. The precheck does not look for them, so it cannot disagree with the service.
14. **Fail closed.** A store the precheck cannot open or read, or arguments it cannot read, is a refusal.
15. **Tested as identical.** `packages/engine/test/precheck.test.ts` runs each adversarial case through the precheck and
    the service against identical worlds; `packages/agent-kit/test/guard.test.ts` runs them through the whole hook path
    (allow-list, schema, precheck) and through the real MCP server and service. Both require the same refusal.

## Other decisions

16. **`read_rota` carries the engine's own comparison with the last run** (`changes`): Saturdays newly Red, dropouts,
    lost leads, over-use, no spare, double bookings, event changes and, in tuning mode, the writes to report. The
    stand-in computes these from engine functions; asking a model to redo coverage arithmetic from 20,000 characters
    of JSON would test arithmetic, not reading. The tools and their schemas are unchanged; one output field is added.
17. **The harness gives each evidence item the date words the engine's grammar accepts.** The service refuses any date
    phrase that is not exactly what the engine's parser would write. The harness runs that parser over each item and
    passes the accepted phrases, so the model quotes them rather than guessing the canonical form. A reason still
    cannot pass, whatever the model writes.
18. **One prompt, one brief, one recorder, for all three.** `packages/agent-kit` holds the system prompt (frozen: no
    dates or names, so it caches), the brief (the tick's evidence, fenced as data, always last), the guard, and a
    recorder that rebuilds the stand-in's DryRun from the tool calls, so the Phase 1a graders judge every build
    unchanged.
19. **The run must be logged.** Each build reminds the model once if it stops without `log_run`: the loop appends a
    user message, the SDK build resumes the session, the managed build sends a message.
20. **Caching.** One explicit breakpoint on the system prompt (tools and system together), plus automatic caching for
    the growing conversation, as the skill recommends for agent loops. A test checks the prefix is byte-identical
    across ticks with different evidence; the live test checks cache reads on the second tick.
21. **Effort.** `medium` on every build, so they are compared like for like, and to keep spend down. Opus 5.5 defaults
    to `medium`; Sonnet 5.5 defaults to `high`.
22. **The ledger.** Usage is recorded from every response (input, output, cache reads, five-minute and one-hour cache
    writes) at the skill's list prices; fallback hops are priced at the model that served them. The running total is
    the whole file across every process, and the process stops when it passes $60, a constant (it was $100 until the live runs; see 2). An unpriced model is
    refused, never recorded as free. Managed Agents spend is recorded per model request and then reconciled to the
    session's own list cost, which includes running time.
23. **Agent SDK isolation.** The session gets its own config directory and home, PATH and the API key only, a
    scratch working directory, and no settings, skills, plugins or other servers. Its init message is checked at run
    time: any tool beyond the eight stops the tick.
24. **Resuming.** The SDK build stores the session id against the tick id as soon as the session starts, and keeps a
    call journal, so a killed tick resumes with the conversation and its record intact. No human decision is lost or
    repeated, because approvals live in the store and each is used once.
25. **Scheduled runs.** Weekdays at 13:00 and 18:00 London time, each fired session capped at $2, and a worker that
    serves at most two runs a day and interrupts any beyond that. A morning-after report lists every run with its cost,
    whether it messaged the organiser and whether it logged.
26. **Model ids live in `config.ts`.** Sonnet 5.5 for all three builds, Opus 5.5 only for the comparison runs, Haiku 5.5
    for bulk checks.
27. **Cases the stand-in skips are run for the builds.** The recurring-weekdays case is beyond the stand-in's reader
    but not, perhaps, a model's. It is graded for the builds and never counted as a flip.
28. **The HTTP test binds a local port**, which this sandbox blocks; it was run with binding allowed, and runs as is in
    CI.
29. **The SDK hands a PostToolUse hook the tool's result as a plain string,** not content blocks. Measured on the first
    live SDK case, from the session transcript; the hook now reads both.
30. **An authority refusal from a harness check is recorded as the service's own refusal** (its refusal code), in the
    SDK hook and the Managed Agents confirmer; a schema refusal is recorded as a malformed call. Before this, the SDK
    run lost calendar-move-needs-approval to the recording, not the model. The run is kept as it was; the one case was
    re-run after the fix and is on file as an addendum, not merged into the run.
31. **The prompt was not tuned while the builds were measured.** All runs use the same system prompt, so the builds
    stay comparable. The cases every build fails are listed in the comparison as the next prompt work.
32. **The deny-list treats lowercase hex digests as hashes.** A pull request's merge commit names git ids (40 hex), and
    the exported event logs carry the engine's sha256 approval fingerprints (64 hex); neither is a document id, which is
    mixed-case base64url. A diff header's file name is checked for denied words but not taken for an id.

## Spend

$32.74 in all, under the $60 stop: the Messages API build on Sonnet 5.5 $15.40 (one run, three repeats and a smoke
test), the Opus 5.5 comparison $7.46, Managed Agents $3.93, the Agent SDK $3.47, the recorded fortnight $2.33, the
strict-schema probes $0.14 and the live cache check $0.01.
