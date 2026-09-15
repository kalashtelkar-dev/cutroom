---
id: auto-broll-weave
kind: pipeline
rung: 3
cost: 45s/min · gpu
match: weave, weave in, weave it in, cut them in, put them on v2, lay it over, do the whole thing
veto: at 0:, at 00:, exactly at, specific moment, punch in, zoom in, get closer, tighter, plan, prompts, image prompt, video prompt, stock footage
---

## What it does
Detects scenes, samples three stills per scene into contact sheets,
runs a vision pass for who is on screen, transcribes to word level,
then asks a planner model for candidate windows. Ten deterministic
gates re-check every number against measured values before anything
is returned.

Then it trims each candidate and lays the result on V2, so this one
does not stop at a plan: it ends with clips on the timeline.

## When to use it
When the ask is for the cutaways to end up on the timeline rather than
for a plan to read. This is the longer, more expensive half of the job.

"Weave it in", "cut them in for me", "do the whole thing and put them
on V2".

## When NOT to use it
- The ask is for the plan, the timings or the prompts. That is
  `broll-b1`, which claims the plain b-roll vocabulary, costs less and
  puts nothing on the timeline.
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
    "params": {
      "video": "$source"
    }
  },
  {
    "kind": "fanout",
    "over": "$broll",
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
    "from": "$broll"
  }
]
```
