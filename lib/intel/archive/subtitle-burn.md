---
id: subtitle-burn
kind: pipeline
rung: 3
cost: 40-90s · gpu
match: subtitle, subtitles, captions, caption, subs, burn in, srt, vtt
veto:
---

## What it does
Transcribes to word level, renders SRT and VTT, and burns the result
into the picture on the delivery pass.

## When to use it
Any ask for subtitles or captions, burned or sidecar.

## When NOT to use it
- There is no speech. Check vad/segments.speechRatio first; below
  ~0.15 this returns cues nobody wants.
- The user wants a *translation*, that is whisperx/translate, and
  the timings differ.

## Failure modes
| signal | meaning |
|---|---|
| degenerate: true | transcript collapsed, audio is poor |
| languageProbability < 0.6 | wrong language detected |

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

```json
[
  {
    "kind": "pipeline",
    "pipelineId": "tpl_subs",
    "input": "$program"
  },
  {
    "kind": "timeline-op",
    "op": "add_track",
    "kindOfTrack": "subtitle",
    "name": "ST1"
  }
]
```
