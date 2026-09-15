---
id: subtitle-burn
kind: pipeline
rung: 3
cost: 40-90s · gpu
match: subtitle, subtitles, captions, caption, subs, burn in, srt, vtt
veto:
---

## What it does
Runs `tpl_U3GJUhH92LC_` ("Speech to subtitles"), a published pipeline
on this account wrapping `whisperx/subtitle`, which transcribes to
word level and renders SRT. The file lands on a new subtitle track, and
the delivery pass burns it in when Export has subtitles turned on.

## When to use it
Any ask for subtitles or captions, burned or sidecar.

## When NOT to use it
- There is no speech. Check vad/segments.speechRatio first; below
  ~0.15 this returns cues nobody wants.
- The user wants a *translation*, that is whisperx/translate, and
  the timings differ.
- The ask is to shorten the edit rather than caption it. That is
  `tighten-cut`, which reads the same transcription for a different
  purpose and costs the same round trip.

## Failure modes
| signal | meaning |
|---|---|
| degenerate: true | transcript collapsed, audio is poor |
| languageProbability < 0.6 | wrong language detected |

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

The pipeline's one input node is named `video`, so that is the key the
run body is bound to, and the value is `$source`: the object key the
editor has already checked is readable. `$program`, which this card used,
is not a binding anything sets, so it reached the API as the literal
string "$program" and came back `input_unreachable`. `tpl_subs`, which
this card named before that, was never an id at all.

```json
[
  {
    "kind": "pipeline",
    "pipelineId": "tpl_U3GJUhH92LC_",
    "params": {
      "video": "$source"
    }
  },
  {
    "kind": "timeline-op",
    "op": "add_track",
    "kindOfTrack": "subtitle",
    "name": "ST1"
  }
]
```
