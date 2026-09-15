---
id: timeline-ripple
kind: timeline-op
rung: 1
cost: ~20ms · local
match: delete, remove, drop this, get rid, close the gap, ripple
veto: broll, b-roll, subtitle
---

## What it does
Removes the selected clip and pulls everything after it left, so no
gap is left behind.

## When to use it
The user points at something and wants it gone: "delete this",
"drop that shot", "take this out and pull everything up".

## When NOT to use it
- The user wants a gap left behind, that is a lift, not a ripple.
- The user has not said *which* clip. Ask, or score first.

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

```json
[
  {
    "kind": "timeline-op",
    "op": "ripple_delete",
    "target": "$selection"
  }
]
```
