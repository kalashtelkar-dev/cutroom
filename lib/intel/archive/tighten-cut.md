---
id: tighten-cut
kind: pipeline
rung: 3
cost: 20-60s · mixed
match: tighten, shorten, shorter, cut down, trim it down, too long, get it to, seconds, under a minute, waffle, drop the slow
veto: broll, b-roll, cutaway
---

## What it does
Runs `tpl_sL6bBxQdzFQO` ("Video/Audio to Subtitles"), a published
pipeline wrapping `whisperx/subtitle`, which writes SRT, VTT and JSON.
The JSON is the one that matters: it carries `segments`, sentence by
sentence with start and end times. That file is read, every sentence is
scored against what the user asked for, and the weakest are rippled out
until the target length is hit. Stops at the first cut that overshoots
rather than trimming mid-sentence.

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

## Why it reads a file
A pipeline hands back object keys, not data. `segments` is a port inside
the graph and it is not in the run's reply, so the only way to the
sentence timings is to read the `.json` the run wrote. That is what the
`read-json` step is for, and it is free: no job, no queue, no GPU.

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

The pipeline's one input node is named `input`, not `video`: it takes
audio as readily as video. The value is `$source`, the object key the
editor has already checked is readable; `$audio` was not a binding
anything set. `tpl_words`, which this card named before that, was never
an id.

```json
[
  {
    "kind": "pipeline",
    "pipelineId": "tpl_sL6bBxQdzFQO",
    "as": "$transcription",
    "params": {
      "input": "$source"
    }
  },
  {
    "kind": "read-json",
    "from": "$transcription",
    "pick": ".json",
    "as": "$transcript"
  },
  {
    "kind": "fanout",
    "over": "$transcript.segments",
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
