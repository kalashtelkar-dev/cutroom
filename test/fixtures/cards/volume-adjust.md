---
id: volume-adjust
kind: operation
rung: 2
cost: 2-8s · cpu
match: louder, quieter, volume, normalise, normalize, too loud, too quiet, levels
veto: music, score, ducking
---

## What it does
One ffmpeg/volume job. Either a flat gain in dB, or a two-pass
loudness normalise to -16 LUFS.

## When to use it
A single clip or track is at the wrong level and the fix is one
number.

## When NOT to use it
- Music ducking under dialogue, that needs a sidechain, which this
  operation cannot do.
- Balancing many tracks against each other. Do those as a mix.

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

```json
[
  {
    "kind": "operation",
    "engine": "ffmpeg",
    "operation": "volume",
    "input": "$selection"
  }
]
```
