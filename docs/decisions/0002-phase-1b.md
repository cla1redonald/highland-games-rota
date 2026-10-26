# 0002: Phase 1b, the same agent three ways

Status: accepted. Date: October 2026.

Phase 1b builds the rota agent three ways on the Phase 1a MCP server: a hand-written Messages API loop, an Agent SDK
build and a Managed Agents build. It adds a cost ledger with a hard stop, a live eval runner, cassettes so the demo can
replay a live run for free, and a comparison. This record lists what was decided where the project brief was silent,
impossible or contradictory, and what could not be done.

## How the live runs went

1. The code was written and tested before any key was available, and run live afterwards. At the time there was no API
   key in the environment, and the CLI's saved sign-in had expired with no refresh token ("user_oauth credentials ...
   has client_id in config but missing refresh_token"). So everything was first tested against stubs. A key was then
   supplied for the live runs and loaded into each command's environment only. It was never written to a file in this
   repo. The results are in `evals/results/`, the ledger is `ledger/spend.jsonl`, and the total is $32.74.
2. The hard stop was lowered from $100 to $60, because the organisation's monthly limit is shared with other work. The
   runs were done in a fixed order of priority. That order was the Messages API build once, its three repeats, the
   Agent SDK build once, Managed Agents once, the recorded fortnight, and then an Opus 5.5 comparison only if the total
   was still under $40. It was $25.28 at that point.
3. Managed Agents is available on this account. The agent, environment and deployment were created in code, and the
   platform read the weekday schedule as 12:00 and 17:00 UTC (13:00 and 18:00 in London). The deployment was paused as
   soon as it was made, because a run that fires waits for a worker and none is kept running. Its ids are in
   `packages/agent-managed/resources/ids.json`.
4. `ant apply` could not be used. The installed CLI is 1.10.0, and applying resource files needs 1.30.0 or later. The
   resources are written in the `ant apply` layout anyway (`packages/agent-managed/resources/`). With a newer CLI,
   `npm run managed -- setup` prints the `ant apply` command. Otherwise it creates each resource once in code and keeps
   its id. Whether to apply is for the owner to decide, and the harness never does it.

## Contradictions and impossibilities, and the simpler option taken

5. The deny-list denies the provider's name, and Phase 1b has to depend on two packages in the provider's npm scope. A
   package specifier (`@scope/name`) and the bin entry the lockfile records for it are now exempt, but only when that
   scope is an installed dependency in `package-lock.json`. The bare word stays denied everywhere else. So the code
   imports the API client under a neutral local name, and the docs say "the provider". The API-key variable is named
   once, in `.env.example`, and read from there.
6. The project brief asks for the comparison to be in the author's own framing. It is written in the first person and
   names nobody.
7. The project brief asks for a co-author trailer naming one model, unless standing instructions say to name the model
   that did the work. They do, so the commits name Claude Opus 5.5. History mode already exempts trailers.
8. The platform's MCP connector reaches servers by URL from the platform's side. To use it, a server on this machine
   would have to be reachable from the internet, through a public tunnel to a store holding the circuit's data, and
   the evals need a fresh store for each case. Neither fits a recorded run on a laptop, so this build takes the
   fallback the project brief allows. The rota tools are Managed Agents custom tools with the server's own names and
   schemas, and the repo runs them against the same MCP server over stdio.
   On this path the platform never touches the server. Every tool call pauses the session until the repo answers, and
   confirm-first means the repo's guard answers before it runs a write. A thin Streamable HTTP transport was still
   added to the server. It binds to loopback only, needs a bearer token on every request, keeps no state and is off
   unless `GHILLIE_HTTP_PORT` is set. The agent definition also has an `mcp` mode with every write tool on
   `always_ask`, so the connector path is one public URL away. No run used it. Nor did any run use the SDK's
   research-preview MCP tunnels API, which the reference notes this build worked from do not document, and which needs a
   connector process and certificates.
9. A deployment fires each session with a fixed opening message, so a scheduled run cannot carry the tick's evidence
   in its brief. The managed agent therefore has one extra custom tool, `gather_evidence`, which returns the same brief
   the other builds are given. The worker that answers scheduled sessions serves that tool as well. The rota server
   keeps its eight tools.
10. The server's schemas use constraints that strict tool use does not accept. These are string lengths, item counts,
   numeric bounds, patterns, tuples and objects keyed by an enum. The API is sent a strict copy with those removed or
   rewritten as plain shapes, and every call is still validated against the server's full schema before it runs. The
   strict copy only ever loosens the schema, and it is deterministic, so it never breaks the prompt cache.
   Live, the API refused more than that. It allows at most 24 optional parameters across all strict schemas in a
   request, and the eight tools have 49. With seven tools strict it said "the compiled grammar is too large", though
   any six compile. `message_organiser` (26 optional parameters on its own) and `log_run` (whose fields are copied from
   the brief) are sent without strict. Both refusals came before any token was billed, and probing the combinations
   cost $0.14.
11. The project brief asks for the organiser's identity to be "injected by the harness". The harness names the
   organiser from configuration and marks which evidence came from her own channel, meaning her sender id on her
   direct-message channel, as decided by the feed adapters. No tool takes an identity, so there is nothing for the
   model to supply. An earlier version also checked `saidBy` against trusted evidence in the guard, and item 12 covers
   what replaced it.

## Decisions taken in review

12. Authority is decided in one place. A security review of the first pre-tool-use check found that it read trust from
    the call itself (`saidBy`, `source`, `evidenceAt`) and kept rules of its own. Now `authorise()` in
    `packages/engine/src/authority.ts` is the only place authority is decided. It reads the approvals ledger, looking
    for a grant for exactly this action's fingerprint that has been neither used nor declined, and the mode held in
    the store. It reads nothing else. The service calls it at the moment of a write, and `precheckCall()` calls it
    before a call reaches the service. The call's arguments only name the action. A forged approval id, a replayed
    approval, an approval for a different action, and a used or withdrawn approval all fail in the same way, because
    the only way to find a grant is to recompute the action's fingerprint.
13. Fields that would carry authority are refused by the schema before the precheck runs. Every tool's schema is
    closed, and the harness guard validates against it first. That is where `approved`, `actor`, `approver`, `mode`, an
    approval id or a `to` gets refused. The precheck does not look for them, so it cannot disagree with the service.
14. The precheck fails closed. If it cannot open or read the store, or cannot read the arguments, the call is refused.
15. The two paths are tested as identical. `packages/engine/test/precheck.test.ts` runs each adversarial case through
    the precheck and through the service against identical worlds. `packages/agent-kit/test/guard.test.ts` runs them
    through the whole hook path (allow-list, schema, precheck) and through the real MCP server and service. Both tests
    require the same refusal.

## Other decisions

16. `read_rota` carries the engine's own comparison with the last run, in a field called `changes`. It lists Saturdays
    newly Red, dropouts, lost leads, over-use, no spare, double bookings, event changes and, in tuning mode, the writes
    to report. The stand-in works these out with engine functions. Asking a model to redo the coverage arithmetic from
    20,000 characters of JSON would test its arithmetic, and the point is to test its reading. The tools and their
    schemas are unchanged apart from that one added output field.
17. The harness gives each evidence item the date words the engine's grammar accepts. The service refuses any date
    phrase that is not exactly what the engine's parser would write. So the harness runs that parser over each item
    and passes on the accepted phrases, and the model quotes them instead of guessing the exact form. A reason still
    cannot get through, whatever the model writes.
18. All three builds share one prompt, one brief and one recorder, kept in `packages/agent-kit`. The system prompt is
    frozen, with no dates or names in it, so it caches. The brief holds the tick's evidence, fenced off as data and
    always placed last. The kit also has the guard, and a recorder that rebuilds the stand-in's DryRun from the tool
    calls so the Phase 1a graders can judge every build unchanged.
19. The run must be logged. If the model stops without calling `log_run`, each build reminds it once. The loop appends
    a user message, the SDK build resumes the session and the managed build sends a message.
20. There is one explicit cache breakpoint on the system prompt (tools and system together), plus automatic caching for
    the growing conversation, which is what the reference notes recommend for agent loops. A test checks that the prefix
    is byte-identical across ticks with different evidence, and the live test checks for cache reads on the second
    tick.
21. Every build runs at effort `medium`, so they are compared like for like and spend stays down. Opus 5.5 defaults to
    `medium`, and Sonnet 5.5 defaults to `high`.
22. The ledger records usage from every response, covering input, output, cache reads, and five-minute and one-hour
    cache writes, at the list prices in the reference notes. Fallback hops are priced at the model that served them. The
    running total covers the whole file across every process, and the process stops when it passes $60, which is a
    constant. It was $100 until the live runs (see item 2). A model with no price is refused, and never recorded as
    free. Managed Agents spend is recorded per model request and then reconciled to the session's own list cost, which
    includes running time.
23. The Agent SDK session is isolated. It gets its own config directory and home, PATH and the API key only, and a
    scratch working directory. It gets no settings, skills, plugins or other servers. Its init message is checked when
    it runs, and any tool beyond the eight stops the tick.
24. The SDK build stores the session id against the tick id as soon as the session starts, and keeps a call journal.
    A tick that is killed resumes with its conversation and its record intact. No human decision is lost or repeated,
    because approvals live in the store and each is used once.
25. Scheduled runs fire at 13:00 and 18:00 London time on weekdays, and each fired session is capped at $2. The worker
    serves at most two runs a day and interrupts any beyond that. A morning-after report lists every run with its cost,
    whether it messaged the organiser and whether it logged.
26. Model ids live in `config.ts`. Sonnet 5.5 is used for all three builds, Opus 5.5 only for the comparison runs, and
    Haiku 5.5 for bulk checks.
27. The builds are run on the cases the stand-in skips. The recurring-weekdays case is beyond the stand-in's reader,
    but perhaps not beyond a model. It is graded for the builds and never counted as a flip.
28. The HTTP test binds a local port, which the sandbox used for the build blocks. It was run with binding allowed, and
    it runs unchanged in CI.
29. The SDK hands a PostToolUse hook the tool's result as a plain string, and not as content blocks. This was measured
    on the first live SDK case, from the session transcript, and the hook now reads both.
30. When a harness check refuses a call for lack of authority, it is now recorded as the service's own refusal, with
    the service's refusal code, in both the SDK hook and the Managed Agents confirmer. A schema refusal is recorded as
    a malformed call. Before this change, the SDK run lost calendar-move-needs-approval because of how the refusal was
    recorded, and the model was not at fault. The run is kept as it was. The one case was re-run after the fix and is
    on file as an addendum, and it is not merged into the run.
31. The prompt was not tuned while the builds were being measured. Every run uses the same system prompt, so the builds
    stay comparable. The comparison lists the cases every build fails as the next work on the prompt.
32. The deny-list treats lowercase hex digests as hashes. A pull request's merge commit names git ids (40 hex), and the
    exported event logs carry the engine's sha256 approval fingerprints (64 hex). Neither is a document id, which is
    mixed-case base64url. A file name in a diff header is checked for denied words but is not taken for an id.

## Spend

The total was $32.74, under the $60 stop. The Messages API build on Sonnet 5.5 cost $15.40 (one run, three repeats and
a smoke test), the Opus 5.5 comparison $7.46, Managed Agents $3.93 and the Agent SDK $3.47. The recorded fortnight cost
$2.33, the strict-schema probes $0.14 and the live cache check $0.01.
