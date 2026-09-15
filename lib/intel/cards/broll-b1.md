---
id: broll-b1
kind: pipeline
rung: 3
cost: 180-440s · gpu
match: broll, b-roll, cutaway, cutaways, talking head, cover this, something to look at, stock footage, generate broll
veto: at 0:, at 00:, exactly at, specific moment, punch in, zoom in, get closer, tighter
---

## What it does
Reads the video's exact duration, pulls a 16kHz mono track, and cuts it
into 60 second windows. Each window is transcribed on its own by
WhisperX large-v3, then read by a planner that sees **only** that one
window and proposes at most two cutaways in it, timed relative to the
window. Absolute time comes from the window's own index times 60, never
from counting candidates, and a final pass enforces four hard rules:
inside the video, inside its own window, never going backwards, and
1.5 to 5.0 seconds with 8 seconds of air between takes.

Returns a **plan**, not media. Every entry carries the verbatim quote it
covers, an image prompt, a video prompt and a stock search phrase, so the
footage can be generated or found afterwards.

Cost scales with length, not content: one transcribe job and one planner
call per 60 seconds of video.

## When to use it
Any ask for b-roll or cutaways over someone talking, and any ask for the
prompts to make that footage with.

"Generate broll for this video", "add some cutaways", "it's just me
talking for four minutes", "what should I show while he says that".

## When NOT to use it
- The user already knows the moment ("cutaway at 0:12"). That is a
  timeline-op at 20ms against minutes of GPU, and the veto list says so.
- No speech. Every candidate is anchored to a quote, so a silent clip
  returns an empty plan and the GPU time is spent for nothing.
- Under about 60 seconds of video. That is one window, and one window
  yields at most two candidates.
- The user wants the footage cut in, not planned. This hands back
  timings and prompts; putting clips on V2 is a separate step.

## Parameters
- `video` (file:video), required. The pipeline's one input node is named
  `video`, and a run is keyed by input NAME, so the plan binds
  `video: $source`. `$source` is the object key the editor resolves from
  whatever the tool was pointed at.
- The whole source file, not a selection range: the planner needs the
  duration to bound every candidate, and the times it returns are in that
  file's own seconds.

## Chaining
Returns `broll_plan`, and alongside it `duration`, `window_starts`,
`window_durations`, `transcript`, `candidates`, `language` and
`word_json`. Each becomes a binding, so `$broll_plan` is what a later
step iterates.

`broll_plan` is `{ broll: [{ start, end, duration, quote, scene, reason,
image_prompt, video_prompt, search_query, confidence }], count, dropped,
dropped_reasons }`. Times are absolute seconds. `candidates` is the raw
per window output before the rules ran, kept for audit.

## Failure modes
| signal | meaning | do |
|---|---|---|
| broll: [] | the planner declined every window | say so; do not retry hotter |
| count 0 with dropped high | the rules rejected the plan | read dropped_reasons, it names the rule |
| a start past duration | a window was miscounted | re-run; the fix pass drops these |
| language not what was expected | the wrong track was transcribed | check the audio before spending again |

## Worked examples
> "Generate broll for this video"

One pipeline step. The plan comes back with absolute timings and a
prompt per cutaway; nothing is added to the timeline.

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

```json
[
  {
    "kind": "pipeline",
    "pipelineId": "tpl_t061ug0SgLjN",
    "params": {
      "video": "$source"
    }
  }
]
```
