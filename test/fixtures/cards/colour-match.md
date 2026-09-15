---
id: colour-match
kind: graph
rung: 4
cost: 30-80s · mixed
match: colour, color, grade, warmer, colder, cooler, match the look, even them out, inconsistent
veto: subtitle, broll
---

## What it does
Samples frames per clip, measures the dominant palette, asks a model
for per-clip temperature offsets, then patches each clip. Built as an
ad-hoc graph because no saved pipeline covers it.

## When to use it
Shots that do not match each other. "The drone stuff is colder than
the interviews."

## When NOT to use it
- A single clip needs a look, that is one adjust operation, rung 2.
- The user wants a creative grade rather than consistency. This
  measures and equalises; it has no taste.

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

```json
[
  {
    "kind": "operation",
    "engine": "ffmpeg",
    "operation": "frames",
    "input": "$eachVideoClip"
  },
  {
    "kind": "operation",
    "engine": "imagemagick",
    "operation": "palette",
    "input": "$frames"
  },
  {
    "kind": "graph",
    "note": "ad-hoc, ~6 nodes \u2014 no saved pipeline covers this"
  },
  {
    "kind": "timeline-op",
    "op": "patch_clip",
    "target": "$eachVideoClip",
    "set": {
      "temperature": "$offset"
    }
  }
]
```
