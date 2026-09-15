---
id: auto-broll-weave
kind: pipeline
rung: 3
cost: 45s/min · gpu
match: broll, b-roll, cutaway, cutaways, talking head, boring, variety, cover this, something to look at
veto: at 0:, at 00:, exactly at, specific moment, punch in, zoom in, get closer, tighter
---

## What it does
Detects scenes, samples three stills per scene into contact sheets,
runs a vision pass for who is on screen, transcribes to word level,
then asks a planner model for candidate windows. Ten deterministic
gates re-check every number against measured values before anything
is returned.

Returns a **plan**, not media.

## When to use it
"It's just me talking", "add some cutaways", "make this less of a
talking head".

## When NOT to use it
- The user already knows the window ("cutaway at 0:12"). That is a
  timeline-op and costs 20ms instead of three minutes.
- Footage under ~20s, scene detection has nothing to work with.
- No speech. The planner keys off word timing; a silent clip returns
  an empty array and you have paid GPU time for nothing.

## Failure modes
| signal | meaning | do |
|---|---|---|
| broll: [] | planner declined | say so; do not retry hotter |
| vadSpeechRatio < 0.15 | nearly silent | skip entirely |

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

```json
[
  {
    "kind": "pipeline",
    "pipelineId": "tpl_75e1fLGX64dF",
    "input": "$selection"
  },
  {
    "kind": "fanout",
    "over": "$candidates",
    "maxParallel": 2,
    "body": [
      {
        "kind": "operation",
        "engine": "ffmpeg",
        "operation": "trim",
        "input": "$item"
      }
    ]
  },
  {
    "kind": "timeline-op",
    "op": "add_clip",
    "track": "V2",
    "from": "$candidates"
  }
]
```
