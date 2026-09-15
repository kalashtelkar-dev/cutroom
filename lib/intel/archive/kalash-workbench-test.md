---
id: kalash-workbench-test
kind: pipeline
rung: 2
cost: 20-60s · gpu
match: extract audio, audio track, pull the audio, strip the audio, wav, soundtrack
veto: transcribe, transcript, subtitle, caption, srt, what did they say
---

## What it does
Takes video (file:video). Pull the audio track out. Returns audio.

## When to use it
The user wants the sound as a file of its own, and nothing done to it. A wav to hand to a transcriber, to open in a DAW, or to send to someone who does not want the picture. The video is left alone.

"give me just the sound as a file", "save the audio on its own".

## When NOT to use it
- The user wants the audio CHANGED rather than separated. Levels, gain and
  normalising are volume-adjust, which is the same rung and does the thing
  they asked for.
- The user wants WORDS out of the audio. This returns a file, not a
  transcript, so stopping here leaves them holding a wav they did not ask
  for. Transcription and subtitles both begin with an extract and neither
  ends with one.
- The clip already sits on an audio track in the timeline. The sound is
  there; nothing needs to run.

## Parameters
- `video` (file:video), required

## Chaining
Returns `audio`.
Runs on ffmpeg.

## Failure modes
- A source it cannot read fails the whole run, because the graph is one step wide.
- GPU work queues behind whatever else is running.

## Worked examples
> "give me just the sound as a file"
> "save the audio on its own"
{ kind: 'operation', engine: 'ffmpeg', operation: 'extract-audio' }

## Plan
What the router emits when this card wins. Steps are typed; the validator
checks them before anything runs.

```json
[
  {
    "kind": "operation",
    "engine": "ffmpeg",
    "operation": "extract-audio",
    "input": "$video"
  }
]
```
