# 0001: Phase 1a, the deterministic foundation

Status: accepted. Date: October 2026.

Phase 1a builds everything an agent needs except the agent: the engine, the fictional world and its fortnight, the
store, the MCP server, a rule-based stand-in, the eval harness, CI and a README skeleton. It makes no call to any paid
API. This record lists what was decided where the brief was silent, impossible or contradictory, and what was cut.

## Contradictions and impossibilities, and the simpler option taken

1. **The deny-list and `.env.example`.** The brief asks for `.env.example` holding one empty API-key variable named
   after the model provider, and for a deny-list that fails on that provider's name anywhere outside the licence and
   package.json author fields. Both cannot hold. The deny-list exempts exactly that one empty line in `.env.example`.
2. **The deny-list and the commit trailer.** Every commit must end with a co-author trailer whose address contains the
   same name, and the deny-list must also run over `git log -p`. In history mode, commit trailers are exempt.
3. **TypeScript's current major.** TypeScript 7 is current, but typescript-eslint supports up to 6.0. The repo pins
   TypeScript 6 so lint can run type-aware rules.
4. **Substring matching.** Read literally, the deny-list would fail on ordinary words that contain a short denied name
   ("problem" contains one). Matching is case-insensitive on whole words and two-word phrases, with camelCase split.
5. **The deny-list never lives in the repo.** A list of the denied names, plain or hashed, would publish the very
   associations it exists to hide. The check reads its terms from the `DENY_LIST` environment variable (a repository
   secret in CI) or, locally, from a gitignored `.denylist` file, and fails if the list is empty, so CI cannot pass
   silently. Its tests use made-up terms of their own. Earlier commits that held a hashed list were rewritten out of
   history before the first report.
6. **Workspace-shaped ids.** The pattern `[CDU][0-9A-Z]{8,}` would also match long upper-case constants, so the code
   uses camelCase constants and the pattern is matched on word boundaries. The fictional chat uses lower-case ids.
7. **Node.** CI runs Node 22 from `.nvmrc`. The repo was developed on a newer Node; nothing depends on it.

## Decisions taken in review: the service validates, the caller never decides

A security review of the first engine commit found the write path trusted the caller in several places. These are the
resulting rules, each with tests (`packages/engine/test/security.test.ts`, `words.test.ts`,
`packages/mcp-server/test/stdio.test.ts`, `packages/stand-in/test/spoofing.test.ts`, `run.test.ts`).

8. **Authority comes only from approvals.** Decisions, event changes, status changes and adding a person need an
   approval record created on the organiser's own path (the console), bound to a fingerprint of the exact action,
   used once and marked used in the same transaction as the write. A refused write never spends an approval. No tool
   takes an actor, an approver, an approval flag, the mode or a recipient; `set_decision` and `update_event` take no
   speaker at all. `saidBy` on evidence is provenance, recorded and never used to authorise.
   *Consequence:* the organiser's word in chat is not an approval. When she says a booking the agent has no approval
   for, it asks her to approve it. In the demo her console approvals come just before her announcements.
   *Stricter than the source rules:* an event move announced by the circuit, and a person saying they are out, now
   also wait for her approval.
9. **The organiser is recognised by her sender id on her own channel.** Only a message from her configured chat user
   id on her configured direct-message channel with Ghillie carries her authority. Mail (a From address can be forged)
   and call notes (names are transcriptions) never do. Anyone else using her name is an ordinary member.
10. **No free text from a source is stored, logged or sent.** Callers give structured fields: an answer and its basis,
    date words, a statement of verdicts, a next step from a fixed list of actions, structured exceptions and readings.
    The service writes every word. Free-text notes, risks, surnames, pronouns and event notes are not writable by the
    agent. The run summary is computed by the service, and evidence ids are kept only as digests.
11. **Date words come from a closed grammar.** The engine's date parser understands dates, day and month names,
    "until", "from", "the week of", durations and numbers, and writes the words itself (the weekday comes from the
    date). The service accepts a phrase only if it is exactly what the parser would write, or an event name. A
    keyword privacy filter remains as a second line.
12. **One deliberate exception:** a recruit's name, which the organiser needs. It must be two or three capitalised
    words and pass the privacy check. Unmatched names are not repeated at all.
13. **Conditions are not kept.** The source rules let the message name a money or travel condition. Under rule 10 the
    message says "Maybe (condition)" and the organiser reads the source.
14. **The write cap counts attempts,** refused ones included, since the last run was logged.
15. **Every field refuses older evidence,** notes included. A late statement that is older than the newest note line
    is not appended.

## Other decisions

16. **Red is reported when it is new or worse,** or when a Saturday's delta falls below zero, not on every run while it
    stays Red. Otherwise the organiser hears about the same Red Saturday twice a day.
17. **Each source keeps its own window.** A source that failed is read again from where it last worked, so a timeout
    loses nothing.
18. **Evidence already read is not reported again.** Overlapping windows and replays re-apply writes (they are no-ops)
    but never repeat readings, raises or note lines.
19. **The stand-in talks to the MCP server in memory** (`InMemoryTransport`) for the demo and the evals, so they are fast
    and deterministic. The stdio transport is tested separately against a spawned server.
20. **Pencilling, hand edits and approvals are the organiser's console,** a library API in the engine. There is no MCP
    tool for them, and the demo drives them from `console.json`.
21. **"Until X" for an event** makes that event No and says nothing about events after it.
22. **The footprint is Friday to Sunday for every games,** and a hard clash anywhere in it is No.
23. **Over-use is flagged on the person's third Saturday running at a game within six weeks,** newly since the last run.
    The organiser arranging over-use at someone's own request is not modelled.
24. **The watchdog checks each scheduled slot** at 20:00 on weekdays, and any run that had something to say but could
    not say it.
25. **The eval harness passes evidence directly** rather than through the feed adapters, so "open each thread" and
    "match call notes by time" are tested in the stand-in's unit tests, not in the eval. One case (recurring weekdays)
    is skipped because the stand-in's reader cannot do it; it is reported as skipped, never as a pass.
26. **Model ids are empty** in `packages/engine/src/config.ts`, and the cost ledger reads zero.

## Cut from Phase 1a

- The three agent implementations (Phase 1b): a hand-written Messages API loop, an Agent SDK build and a Managed
  Agents deployment, all consuming this MCP server.
- Real connectors for chat, mail, call notes and calendars. The feed adapters read fixture files.
- An organiser console with a user interface. It is a library API, driven by the fixtures.
- A remote (HTTP) MCP transport. Stdio and in-memory only.
- Accepting a Saturday's suggested split in one action exists in the engine but is not shown in the demo.
- "Final" Saturdays, venues, per-arena assignments, and a rulings log that learns from the organiser's corrections.
- The stand-in's reader covers the planted phrasings and close variants. It is not a general reader of English; that
  is what the Phase 1b agents are for.
