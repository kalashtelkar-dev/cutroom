---
id: tighten-cut
kind: pipeline
rung: 3
cost: 20-60s · mixed
match: tighten, shorten, shorter, cut down, trim it down, too long, get it to, seconds, under a minute, waffle, drop the slow
veto: broll, b-roll, cutaway
---

## What it does
Scores every sentence in the transcript against what the user asked
for, then ripples out the weakest until the target length is hit.
Stops at the first cut that overshoots rather than trimming
mid-sentence.

## When to use it
A length target, explicit or implied: "get it to 30 seconds", "this
drags", "cut the waffle".

## When NOT to use it
- There is no speech to score against.
- The user wants B-roll rather than removal, covering a slow patch
  and deleting it are different asks.

## Chaining
- Feeds into: subtitle-burn (re-run after, timings move)
- Requires before: nothing

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

```json
[
  {
    "kind": "pipeline",
    "pipelineId": "tpl_words",
    "input": "$audio"
  },
  {
    "kind": "fanout",
    "over": "$sentences",
    "maxParallel": 8,
    "body": [
      {
        "kind": "operation",
        "engine": "vllm",
        "operation": "classify",
        "params": {
          "connection": "$vllm",
          "text": "$item.text",
          "labels": "$labels"
        }
      }
    ]
  },
  {
    "kind": "timeline-op",
    "op": "ripple_delete",
    "target": "$rejected"
  }
]
```
