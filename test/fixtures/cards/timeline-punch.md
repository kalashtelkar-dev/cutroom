---
id: timeline-punch
kind: timeline-op
rung: 1
cost: ~20ms · local
match: punch in, zoom in, closer, push in, scale up, tighter framing, tighter on
veto: colour, color, grade
---

## What it does
Scales a clip's transform. Reframing only, nothing re-renders until
the timeline is compiled.

## When to use it
"Punch in on him", "get closer", "push in a bit". Framing changes on
clips that already exist.

## When NOT to use it
- The user means a *speed* ramp, not a scale.
- The user wants an actual crop with different output dimensions.

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

```json
[
  {
    "kind": "timeline-op",
    "op": "patch_clip",
    "target": "$selection",
    "set": {
      "scale": 1.18
    }
  }
]
```
