---
id: subtitle-burn
name: Subtitles
kind: operation
rung: 2
cost: 10-90s · gpu
match: subtitle, subtitles, captions, caption, subs, burn in, srt, vtt, transcribe, translate, translation, translated
veto:
---

## What it does
Listens to the speech and writes it out as subtitles, one cue per
sentence, sitting on the words it belongs to. The cues land as captions
on a subtitle track, and the delivery pass burns them in when Export has
subtitles turned on.

They can be written in the language spoken or in another one. A
translation stays over the footage it belongs to: it covers the same
stretch, and it is free to break a long line into several inside it, which
is what a sentence that reads as three lines in one language and one in
another needs.

**This section is read out loud.** `blurb()` takes its first sentence and
the assistant shows it above the plan, so nothing in here names an engine,
an operation or a saved pipeline. That belongs under `## How it is built`,
which nothing renders.

Measured: 8.5s end to end on a 12.3s clip, pod warm. A cold pod loading
the model is most of the spread in the cost above. A translation adds a
few seconds; it is text, on cpu.

## How it is built
`whisperx/subtitle` returns the aligned cue list. When a different
language was asked for, `vllm/translate` rewrites the cues.

What `vllm/translate` preserves was measured rather than assumed, and it is
not what the schema's "keeping every timing" suggests. It keeps the SPAN,
the first start and the last end to the frame, and re-divides inside it: on
one run over a 6.6s clip it answered one cue for one, and on the next it
split that single segment into three. That is the right behaviour for
subtitles and the wrong thing to have asserted, which is why
`prove:subtitle-language` now checks the span and the ordering rather than a
cue-for-cue match it happened to get the first time.

## When to use it
Any ask for subtitles or captions, burned or sidecar, in the language
spoken or in another one. "Put subtitles on this", "subtitle this in
english", "add hindi captions", "translate this into marathi".

It claims "translate" because translating IS what it does now. It did not,
while the only thing it could produce was the language being spoken, and
"translate this from hindi to english" was declined by a tool that would
have done exactly that.

## When NOT to use it
- There is no speech. Check vad/segments.speechRatio first; below
  ~0.15 this returns cues nobody wants.
- The ask is to shorten the edit rather than caption it. That is
  `tighten-cut`, which reads the same transcription for a different
  purpose and costs the same round trip.

## What the editor reads back
`segments`, the aligned cue list in the job's own result, and not the SRT
the same job wrote. whisperx renders subtitles by filling lines rather
than by honouring the segments it aligned: on a 12.3s clip that is six
sentences in `segments` against two eight-second blocks in
`transcript.srt`, the second of which starts mid-sentence.
`lib/subtitles/cues.ts` carries the measurement.

`language` and `languageProbability` say what it decided it was hearing.
Below 0.6 the guess is worth reporting, because the run before this one
turned Hindi speech into English text and said nothing about it.

## Why not the obvious route
`whisperx/translate` is the obvious way to get English and it is the
wrong one twice over. Both of these were measured against the live API on
one five second Hindi clip:

| what was called | what came back |
|---|---|
| `whisperx/translate`, default model | `नमस्ते यह एक परीक्षण है`. The source language, verbatim. No error, no flag, status `succeeded` |
| the same call plus `model: large-v3` | `Namaste! This is a test.` |
| either, once it does translate | `alignSkipped: translated text cannot be force-aligned against source-language audio`, and ONE segment for the whole clip |

A silent no-op is bad enough. A single cue holding the whole clip is the
exact defect `cues.ts` exists to work around, and it would have put one
caption on screen for the length of the programme. So the path is always
transcribe first, then translate the cues, which keeps the words over the
footage they belong to.

`vllm/translate` needs a connection, named in `VLLM_CONNECTION`. Without
one the translation cannot run, and the editor says so before it spends
anything on the transcription rather than after.

## Options
What the assistant asks before it runs, when the prompt has not already
said. Every `key=value` is a binding the plan below reads. `short:` is what
the answer is filed under once it is given, because the id behind it is the
router's word and not anybody else's.

`spoken` is `assumed: true`, so it is not asked: detection gets it right
nearly always, and a click to confirm a default in front of every subtitle
run is a click that buys nothing. It is still settable, by saying "the audio
is tamil" in the prompt or from the rail's own dropdown, and the panel shows
what it assumed, so a detection that went wrong is visible rather than
silent. `target` is asked, because nothing but the person knows the answer.

### spoken
ask: What language is the speech in?
short: Speech
assumed: true
claims: spoken in {language}, speech is in {language}, speech is {language}, audio is in {language}, audio is {language}, it is in {language}, from {language}, recorded in {language}
free: language sets spoken={code}
- Detect it
- English: spoken=en
- Hindi: spoken=hi
- Marathi: spoken=mr
- Tamil: spoken=ta
- Bengali: spoken=bn

### target
ask: What language should the subtitles read in?
short: Subtitles
claims: {language} subtitles, {language} captions, {language} subs, subtitles in {language}, captions in {language}, subtitle this in {language}, translate to {language}, translated to {language}, translate into {language}, into {language}, to {language}, in {language}
free: language sets rewrite=true, target={name}
- Same as the speech: rewrite=false
- English: rewrite=true, target=english
- Hindi: rewrite=true, target=hindi
- Marathi: rewrite=true, target=marathi
- Spanish: rewrite=true, target=spanish

## Plan
What the router emits when this card wins. Steps are typed; the
validator checks them before anything runs.

`$source` is the object key the editor has already checked is readable.
`$program`, which this card used, is not a binding anything sets, so it
reached the API as the literal string "$program" and came back
`input_unreachable`. `$selection` is worse: it resolves, it is a real
string, and a clip id is not a file.

`$spoken?` is optional, and the `?` is the whole point of it. Omitting
`language` means "detect it", which is a real answer; sending the literal
`"$spoken"` is a two-character ISO code that is neither and the schema
refuses it, and sending null is a present-but-empty param the server
reads as an answer.

`batchSize: 1` is what holds the cue list together, and `system` alone is
not. Left to itself the model re-divides freely: over the same seven seconds
of speech, separate runs gave one cue in and one out, one cue in and THREE
out, four aligned cues in and ONE out, and once an empty list. Adding
`system` improved it and did not fix it, three aligned cues still came back
as one, and one caption on screen for the length of the clip is the exact
defect `whisperx/translate` was rejected for. A batch of one cannot merge two
cues because it is never shown two: each is translated on its own, and the
boundaries survive because nothing was in a position to move them.

The cost is one request per cue instead of one per forty, on cpu, against
text. For a cut with tens of cues that is seconds. For one with hundreds it
is the slowest part of the run, and if that ever matters the fix is to raise
the batch and let `retimeTranslation` catch what comes back wrong, not to
trust a prompt.

`retimeTranslation` in `lib/subtitles/cues.ts` is the belt to that brace:
when the counts line up, the timings come off the aligner, which measured
them against the audio, rather than off a language model, which did not.

Every step carries a `label`, and that is the only thing a person is shown
for it. A step's engine, its operation and a saved pipeline's id are ours:
a run card reading `whisperx/subtitle` tells whoever is watching a progress
bar which models this is built on, and that is not theirs to be handed.
`describeStep` falls back to a generic phrase rather than to the engine, so
forgetting a label loses detail instead of leaking the stack.

There is no `add_track` step. There was one, and it never ran: the
executor applies `blade`, `ripple` and `punch` locally and nothing else,
so the step was a no-op that made the card look finished. It could not
have worked as its own step either, because `commit` applies a batch to
the document as it stood when the run started, so the captions and the
track they need have to arrive together. `placeCuesOps` makes the track
inside the one batch that places the cues.

```json
[
  {
    "kind": "operation",
    "label": "Listening to the speech",
    "engine": "whisperx",
    "operation": "subtitle",
    "params": {
      "input": "$source",
      "language": "$spoken?",
      "formats": ["json"],
      "maxLineWidth": 42,
      "maxLineCount": 2
    }
  },
  {
    "kind": "branch",
    "label": "Deciding whether to translate",
    "when": "$rewrite",
    "then": [
      {
        "kind": "operation",
        "label": "Writing the subtitles in the language you asked for",
        "engine": "vllm",
        "operation": "translate",
        "params": {
          "connection": "$vllmConnection",
          "segments": "$segments",
          "target": "$target",
          "register": "natural",
          "batchSize": 1,
          "system": "You are a subtitle translator. Return EXACTLY one output segment for each input segment, in the same order, with the start and end copied from the input unchanged. Never merge two segments and never split one. Translate the text of each segment on its own, and return nothing but the segments."
        }
      }
    ],
    "else": []
  }
]
```
