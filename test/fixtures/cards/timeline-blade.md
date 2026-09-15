---
id: timeline-blade
kind: timeline-op
rung: 1
cost: ~20ms · local
match: cut here, blade, split, razor, chop, cut at, slice, at 0:, at 00:, insert at, cutaway at
veto: subtitle, transcribe
---

## What it does
Splits the clip under the playhead into two, sharing one media
reference. Pure document patch, no API call, no model.

## When to use it
The user names a place to cut: "split this", "razor at the
playhead". Anything where the *where* is already decided,
including "put a cutaway at 0:12", which names its own window and
must never reach a planning pipeline.

## When NOT to use it
- The user wants the system to decide where to cut. That is a
  scoring problem, not a blade.
- Anything involving speech, subtitles or B-roll.

## Worked examples
> "split this clip at the playhead"
{ kind: 'timeline-op', op: 'blade' }

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

```json
[
  {
    "kind": "timeline-op",
    "op": "blade",
    "at": "$playhead",
    "tracks": "$autoSelect"
  }
]
```
