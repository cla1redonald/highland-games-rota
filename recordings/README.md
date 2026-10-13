# Recordings

What live runs leave behind, kept so they can be read and replayed without spending anything.

- `messages-fortnight/`: the Messages API build's replies for one fortnight, one file per tick, and a manifest with
  each tick's recorded cost. `npm run demo` replays them; `npm run demo:live` records them. Thinking signatures are
  blanked before saving.
- `managed/`: the exported event log of each Managed Agents session, one JSON line per event.

The fortnight was recorded on 12 October 2026 on Sonnet 5.5: 19 ticks for $2.34. The Managed Agents logs are the 37
eval sessions from the same day (`managed/eval/`).
