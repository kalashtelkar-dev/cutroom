---
id: subtitle-burn
kind: pipeline
rung: 3
cost: 10-120s · gpu
match: subtitle, subtitles, captions, caption, subs, burn in, srt, vtt
veto:
---

## What it does
Runs `tpl_cdvkzzJeZylk` ("Video to word timings and subtitle cues"), a
published pipeline on this account. The audio comes out of the video as
16kHz mono wav, `whisperx/words` times every word, `whisperx/subtitle`
returns the aligned cue list, and `whisperx/render` writes srt, vtt and
json sidecars on cpu off the same transcription. The cues land as
captions on a subtitle track, one per sentence, and the delivery pass
burns them in when Export has subtitles turned on.

Measured: 8.5s end to end on a 12.3s clip, pod warm. A cold pod loading
the model is most of the spread in the cost above.

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

## What the editor reads back
`cues`, the aligned segments in the run's own reply, and not the SRT the
same run wrote. whisperx renders subtitles by filling lines rather than
by honouring the segments it aligned: on the clip above that is six
sentences in `cues` against two eight-second blocks in `transcript.srt`,
the second of which starts mid-sentence. The old pipeline's file does
the same, so it is whisperx and not one node's parameters.
`lib/subtitles/cues.ts` carries the measurement.

`words` is per-word start, end and confidence. Nothing on the rail reads
it yet. It is in the reply for word-level captions and for anything that
wants to cut on a word rather than a sentence.

## Failure modes
| signal | meaning |
|---|---|
| degenerate: true | transcript collapsed, audio is poor |
| languageProbability < 0.6 | wrong language detected |
| the text is in the wrong language | whisperx guessed and guessed badly. The published pipeline it ran before this one turned Hindi speech into English text. `language` is a param on the two whisperx nodes, set in the graph, and there is no way to bind it from the run body |

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

The pipeline's one input node is named `video`, so that is the key the
run body is bound to, and the value is `$source`: the object key the
editor has already checked is readable. `$program`, which this card used,
is not a binding anything sets, so it reached the API as the literal
string "$program" and came back `input_unreachable`. `tpl_subs`, which
this card named before that, was never an id at all.

There is no `add_track` step any more. There was one, and it never ran:
the executor applies `blade`, `ripple` and `punch` locally and nothing
else, so the step was a no-op that made the card look finished. It could
not have worked as its own step either, because `commit` applies a batch
to the document as it stood when the run started, so the captions and
the track they need have to arrive together. `placeCuesOps` makes the
track inside the one batch that places the cues.

```json
[
  {
    "kind": "pipeline",
    "pipelineId": "tpl_cdvkzzJeZylk",
    "params": {
      "video": "$source"
    }
  }
]
```
