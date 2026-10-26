# 0001: Phase 1a, the deterministic foundation

Status: accepted. Date: October 2026.

Phase 1a builds everything an agent needs apart from the agent itself. That means the engine, the fictional world and
its fortnight, the store, the MCP server, a rule-based stand-in, the eval harness, CI and a README skeleton. It makes no
call to any paid API. This record lists what was decided where the project brief was silent, impossible or
contradictory, and what was cut.

## Contradictions and impossibilities, and the simpler option taken

1. The project brief asks for `.env.example` to hold one empty API-key variable named after the model provider. It
   also asks for a deny-list that fails on the provider's name anywhere outside the licence and the package.json
   author fields. Both cannot hold, so the deny-list exempts that one empty line in `.env.example` and nothing else.
2. Every commit has to end with a co-author trailer whose address contains the same name, and the deny-list also has to
   run over `git log -p`. In history mode, commit trailers are exempt.
3. TypeScript 7 is the current major, but typescript-eslint supports up to 6.0. The repo pins TypeScript 6 so that lint
   can run type-aware rules.
4. Read literally, the deny-list would fail on ordinary words that happen to contain a short denied name ("problem"
   contains one). Matching is case-insensitive on whole words and two-word phrases, with camelCase split.
5. The deny-list is never kept in the repo. A list of the denied names, plain or hashed, would publish the very
   associations it exists to hide. The check reads its terms from the `DENY_LIST` environment variable (a repository
   secret in CI) or, locally, from a gitignored `.denylist` file. It fails if the list is empty, so CI cannot pass
   without it. Its own tests use made-up terms. Earlier commits that held a hashed list were rewritten out of history
   before the first report.
6. The workspace-id pattern `[CDU][0-9A-Z]{8,}` would also match long upper-case constants. The code uses camelCase
   constants instead, the pattern is matched on word boundaries, and the fictional chat uses lower-case ids.
7. CI runs Node 22, taken from `.nvmrc`. The repo was developed on a newer Node, and nothing depends on it.

## Decisions taken in review, so that the service checks every write itself

A security review of the first engine commit found several places where the write path trusted the caller. The rules
below came out of that review, and each has tests (`packages/engine/test/security.test.ts`, `words.test.ts`,
`packages/mcp-server/test/stdio.test.ts`, `packages/stand-in/test/spoofing.test.ts` and `run.test.ts`).

8. Authority comes only from approvals. Decisions, event changes, status changes and adding a person each need an
   approval record created through the organiser's own console. The approval is bound to a fingerprint of the exact
   action, used once, and marked as used in the same transaction as the write. A refused write never spends an
   approval. No tool takes an actor, an approver, an approval flag, the mode or a recipient, and `set_decision` and
   `update_event` take no speaker at all. `saidBy` on evidence records who said something and is never used to
   authorise anything.
   One result is that the organiser's word in chat is not an approval. When she mentions a booking the agent has no
   approval for, it asks her to approve it, and in the demo her console approvals come just before her announcements.
   The rule is also stricter than the source rules in two places. An event move announced by the circuit, and a person
   saying they are out, now both wait for her approval.
9. The organiser is recognised by her sender id on her own channel. Only a message from her configured chat user id,
   on her configured direct-message channel with Ghillie, carries her authority. Mail never does, because a From
   address can be forged, and nor do call notes, because the names in them are transcriptions. Anyone else using her
   name is treated as an ordinary member.
10. No free text from a source is stored, logged or sent. Callers give structured fields instead: an answer and its
    basis, date words, a statement of verdicts, a next step from a fixed list of actions, and structured exceptions and
    readings. The service writes every word. The agent cannot write free-text notes, risks, surnames, pronouns or event
    notes. The service computes the run summary, and evidence ids are kept only as digests.
11. Date words come from a closed grammar. The engine's date parser understands dates, day and month names, "until",
    "from", "the week of", durations and numbers, and it writes the words itself, taking the weekday from the date.
    The service accepts a phrase only if it is exactly what the parser would write, or an event name. A keyword
    privacy filter stays in place as a second check.
12. There is one deliberate exception to rule 10. The organiser needs a recruit's name, so the name is kept, but it has
    to be two or three capitalised words and pass the privacy check. Names that do not match are not repeated at all.
13. Conditions are not kept. The source rules let the message name a money or travel condition. Under rule 10 the
    message says "Maybe (condition)", and the organiser reads the source for the detail.
14. The write cap counts attempts since the last run was logged, and refused ones count.
15. Every field refuses older evidence, and that includes notes. A late statement that is older than the newest note
    line is not appended.

## Other decisions

16. Red is reported when a Saturday is newly Red or getting worse, or when its delta falls below zero. It is not
    reported on every run while the Saturday stays Red, or the organiser would hear about the same Saturday twice a
    day.
17. Each source keeps its own window. A source that failed is read again from where it last worked, so a timeout loses
    nothing.
18. Evidence that has already been read is not reported again. Overlapping windows and replays apply the writes again
    (they change nothing) but never repeat readings, raises or note lines.
19. For the demo and the evals, the stand-in talks to the MCP server in memory (`InMemoryTransport`), which keeps them
    fast and deterministic. The stdio transport is tested separately against a spawned server.
20. Pencilling, hand edits and approvals happen in the organiser's console, which is a library API in the engine. There
    is no MCP tool for them, and the demo drives them from `console.json`.
21. "Until X" for an event makes that event No and says nothing about the events after it.
22. Every games is treated as running from Friday to Sunday, and a hard clash on any of those days is No.
23. Over-use is flagged on someone's third Saturday running at a game within six weeks, when it is new since the last
    run. The organiser arranging over-use because someone asked for it is not modelled.
24. The watchdog checks each scheduled slot at 20:00 on weekdays. It also catches any run that had something to say but
    could not say it.
25. The eval harness passes evidence straight in rather than through the feed adapters. So "open each thread" and
    "match call notes by time" are tested in the stand-in's unit tests and not in the eval. One case (recurring
    weekdays) is skipped because the stand-in's reader cannot handle it, and it is reported as skipped, never as a
    pass.
26. Model ids are left empty in `packages/engine/src/config.ts`, and the cost ledger reads zero.

## Cut from Phase 1a

- The three agent builds, which are Phase 1b. They are a hand-written Messages API loop, an Agent SDK build and a
  Managed Agents deployment, all using this MCP server.
- Real connectors for chat, mail, call notes and calendars. The feed adapters read fixture files.
- A user interface for the organiser's console. It is a library API, driven by the fixtures.
- A remote (HTTP) MCP transport. There is stdio and in-memory only.
- Accepting a Saturday's suggested split in one action. The engine can do it, but the demo does not show it.
- "Final" Saturdays, venues, assignments per arena, and a log of rulings that learns from the organiser's corrections.
- A general reader. The stand-in's reader covers the planted phrasings and close variants, and it cannot read English
  in general. The Phase 1b agents are there to do that.
