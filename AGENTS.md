<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes: APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev`, verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:cutroom -->

# Cutroom

**No em-dashes anywhere.** Not in UI copy, code, comments or docs. Use a colon,
a comma, or a full stop. `grep -rn "$(printf '\u2014')" --include="*.ts" --include="*.tsx"
--include="*.md" . | grep -v node_modules` must return
nothing before you call anything finished.

An AI video auto-editor for AISuite: a tool-caller layer over the editor API,
a timeline→graph compiler, and a Resolve-class NLE on top. Standalone Next.js
for now; eventually a page inside AISuite.

## Rules that are easy to break and expensive to find

**Time is an integer frame count at the project rate.** `lib/time/frames.ts`
is the only place seconds or `RationalTime` appear. Do not add a `number` of
seconds to a model, a prop or a store, `Frames` is branded so that mistake
does not compile. Ranges are half-open: `[start, start + duration)`, and there
is deliberately no `end` field to disagree with `duration`.

**The graph is a strict DAG and cannot loop.** The only iteration is implicit
fan-out: a multi-valued output wired into a scalar input. A node can be
iterated on **one** port, and there is no zip, `fan_out_twice` is a hard
compile error. Anything needing a computed per-item value, a count, a pairwise
comparison or a retry belongs in the executor, not the graph.

**`ffmpeg/concat` joins its inputs as they are.** It does not scale a picture
to meet another one and it does not put a silent track on a file that has
none, and `reencode: true` does not rescue either case: it is the fussier
path, and additionally insists every input carry both a picture and a sound.
An input set it will not take comes back as `ffmpeg exited 234`, which is
EINVAL, with no diagnostics. So the compiler brings every segment to one shape
in `matchForJoin` and then joins with the demuxer. A track's segments are a
cut at the source's own size beside black generated at the delivery size, and
a sound track's are audio files with no picture at all, so this is not an edge
case: it is every timeline with a gap in it. `npm run prove:concat` measures
the whole table and fails if any of it moves.

**An upper picture track is gated, not made transparent.** A joined strip is
an mp4 and carries no alpha, so the gaps in a track above another one are real
black in a real file, and `ffmpeg/compose` paints them over everything below.
The answer is not to make that black see-through, it is to not draw the layer
where it has nothing: `layerOver` lays the strip on with `overlay`, gated by
`enable='between(t,a,b)+...'`, one run per stretch the track is on screen, and
a disabled overlay passes its base through untouched. A blend that is also
gated splits the base, blends against one copy and lays the result over the
other. Runs are half a frame wide at each end, because frames are sampled at
`n/fps` and a boundary sitting exactly on a sample is a cut that lands a frame
early on some encoders. `npm run prove:layers` builds the two strips, reads
the pixels back out of the rendered file and fails if any of that moves. Past
`MAX_GATE_RUNS` runs the gate is dropped, the black comes back, and the export
says so out loud.

**`enable=` answers that question in time, and a track's SHAPE answers it in
space.** A track above another one used to be built at the delivery size,
which pads a picture of any other shape with black bars before anything lays
it over the track below, and those bars are inside every frame the track is on
screen for, where no gate can reach them. A square still over a vertical cut
previewed clean and exported with black across the top and bottom of the
programme, because the viewer draws an `img` with `object-fit: contain` and
nothing behind it, so in the viewer there is nothing there to draw. So
`trackShape` measures the box a track's own pictures occupy inside the frame
and builds every segment of that track at it, filler included: no pad, no
bars, nothing to lay over anything, and `placement` then fits that box inside
`zoom` times the frame, which is the same picture the viewer draws. It takes
every clip in range agreeing on one box, because a track is laid on as one
layer. A clip with no size, a crop or a rotation that changes its shape after
the cut, or two clips of different shapes all fall back to the delivery frame
and say so in the export. An image had no size to report until recently:
nothing measured a still, because a still never goes through the probe, so
`importFile` reads the picture out of the file with `createImageBitmap`. A
layer that is not the frame is folded with `overlay` and never handed to
`ffmpeg/compose`, whose cells have no documented answer for a picture that
does not fill one. `npm run check:delivery` compiles the demo project
measured and unmeasured and fails if the two come out the same graph.

**Every node that makes pictures states its length in frames, not seconds.**
A compiled export came back 145 frames where the timeline said 144, and
probing every intermediate found two causes at once: `blend` emitted 143
frames from two 144 frame inputs, and the final `transcode` then padded the
picture out to the sound, because AAC packets are 1024 samples and a six
second bed is 6.036854s. So a layer holds its last frame
(`tpad=stop_mode=clone`) and is then cut with `-frames:v`, since `-frames:v`
is a cap and not a floor, and the delivery states `durationSec` from
`secs(compiled.duration, rate)`. `npm run prove:export` measures the frame
count of the rendered file and is the only thing that catches this; the unit
suite was green through both defects.

**A Transform in the inspector and a Transform in the render are one
formula, written twice.** `placement()` in `lib/compiler/compile.ts` mirrors
`layerStyle` in `components/viewer/Layers.tsx`: contain-fit the picture inside
the whole frame, scale about the centre, then translate by a fifth of a
percent of the frame per unit. Change one and change the other, or the viewer
becomes a preview of a file that does not exist. A moved layer is never padded
out to the frame, because the padding would be black laid over the track
below, and a blend mode on one applies inside the picture and nowhere else:
`multiply` against the empty canvas is a black frame. `npm run prove:layers`
renders all three and reads the pixels back.

**Run `preflight()` before `POST /v1/pipelines/validate`.** `lib/editor-api/graph.ts`
answers ten of the twelve compiler codes offline from the catalogue, and its
output is checked to match the server's (`npm run xcheck`). The server is still
the authority; local is just faster for repair loops.

**Every graph node needs a `position`, and every input node a boolean
`required`.** The server checks shape before it compiles and answers 400,
"that is not a pipeline graph", with no useful diagnostics. `preflight()` runs
the same structural pass first so you get told which field is missing;
`GraphBuilder.build()` sets both, so prefer it to hand-writing nodes.

**The playback loop re-renders on a signature, so the signature is the
picture.** The viewer does not re-render per frame: a rAF loop compares
`activeTimelineSignature` in `components/viewer/onscreen.ts` and tells React
the position only when that string moves. Anything drawn from `position` and
missing from the signature is painted once, at the frame playback started, and
then frozen. Captions were missing from it, so subtitles were correct, visible
while scrubbing, and gone the moment you pressed play. Add to the signature
whenever you add something to the frame, and read it from the same function
that draws the thing, not a second walk of the tracks. `npm run
prove:caption-playback` presses Play in a real browser and reads the words back
out of the DOM against the clock's own timecode.

**A cue's length cannot be set with `patch_caption`.** A position on a track
is the sum of the durations before it, so changing one cue's `duration` moves
every cue after it: shorten a line by 12 frames and the rest of the subtitles
slide 12 frames early, off the speech they were written for. This is the
marker bug wearing a different hat. `move_caption` is the op for both a drag
and a trim: it lifts the cue, leaves the hole, and drops it at its new place
and length, so nothing else on the track moves. `test/subtitles.test.ts`
holds the trap itself as a test, so nobody simplifies the op away.

**A cue is dragged with the pointer, and the pointer is the part that
breaks.** The lane was calling `onGrab` for a caption before any of this
existed, and `onGrab` returned early on anything that was not a clip, so cues
were immovable on screen while every unit test of the geometry passed. Then
in-place text editing went the same way: the drag grabs on `pointerdown` and
calls `preventDefault`, which stops the browser ever synthesising the
`dblclick`, so `onDoubleClick` never fired. Both were found by
`npm run prove:caption-edit` and neither was visible to `npm test`.

**A subtitle is an item in the document, not a file in the pool.**
`lib/subtitles/srt.ts` is the only place SRT and the timeline meet, exactly as
`otio.ts` is the only place `RationalTime` appears. SRT's end time is
exclusive against our half-open ranges, so `00:00:01,000 --> 00:00:02,000` is
`[24, 48)` at 24fps, and each cue is converted on its own because SRT times
are absolute (summing durations is the marker bug again).

**`drawtext` cannot carry arbitrary text and `subtitles=` can.** One
`drawtext` per cue, gated like a layer, is the obvious design and ffmpeg
refuses it: `%` is expansion syntax, `:` separates options, and probing the
live API one character at a time found no escaping that satisfies both, with
or without `expansion=none`. The failure is `ffmpeg exited 234` and nothing
else. So captions are written to an SRT, uploaded, and burned with libass:
`exportTimeline` does the upload because the compiler is pure, and
`npm run prove:captions` reads the pixels back out of the rendered file.

**The render container has ONE font and it is DejaVu.** A caption that is
perfect in the viewer comes out of the export as a row of empty boxes the
moment it is not Latin, because the browser falls back through the whole
machine's font book and the container has nothing to fall back to. Burning a
line per script and reading the pixels back says it draws Latin, Greek,
Cyrillic, Arabic, Hebrew, Armenian and Georgian, and draws boxes for every
Indic script, Thai, Han, kana and Hangul. Emoji too, but only the ones that
default to colour: `✅ ❌ 🔥` are boxes and `☺ ★ ✓` draw, which is the
Emoji_Presentation line and not a block range. So `lib/subtitles/fonts.ts` decides
which font the words need, `exportTimeline` uploads it, and the compiler does
TWO things with it, either of which alone renders exactly the boxes it was
meant to remove:

  1. muxes the ttf into the SRT as an mkv attachment, because the subtitles
     filter loads font attachments out of the file it is given and
     `ffmpeg/custom` has no third wire to hand one over on;
  2. names it in `force_style='FontName=...'`, because libass matches an
     attachment by family and will NOT fall back to one for a missing glyph.

The family is the font's own name table string, spaces and all: `Noto Sans
Devanagari` works and `NotoSansDevanagari` matches nothing and says nothing.
Both metadata tags on the attachment are load bearing too, matroska refuses
one with no `filename` and the filter reads `mimetype` to decide an
attachment is a font at all.

`public/fonts` carries 18 Noto fonts for the scripts that were measured as
broken. Two traps live in choosing them. The CJK three are the STATIC Regular
builds from `notofonts/noto-cjk`, not the variable fonts from `google/fonts`:
libass renders a variable font at its default instance and the CJK variable
fonts default to wght 100, so those would have come out hairline rather than
as boxes, which nothing here would have caught. And every bundled font has to
carry Latin, because `force_style` names one font for the whole cue and the
font drawing the Hindi also draws the English beside it.

Which CJK font is not a count. Most of a Japanese sentence is Han, so counting
hands Japanese to the Chinese font and draws it in Chinese letterforms; kana
mean the Han beside them is Japanese, and Hangul mean it is Korean. Measured
from the cmaps: SC has simplified, traditional, the Japan-only kanji and kana
and no Hangul; JP has no simplified; KR has only Hangul of the three.

`npm run prove:caption-font` renders it for a TrueType variable font and for a
CFF OpenType, which are not the same file, and compares the caption band with
`imagemagick/compare`: two identical renders answer exactly 0 and every real
difference measured above 0.007. Do NOT read that against the 0.02 in
compare's own summary, which is a sentence about photographs and fails every
one of these on renders that are perfect. Nothing bundles an emoji font, so
`✅` is still a box and still says so.

**A render is as long as the PROGRAMME, not as long as the timeline.** An
export came back four seconds longer than the cut with nothing in the tail.
The length was the longest track of any kind, summed item by item, and three
separate things reach past the last frame that carries anything: a gap left
behind by a delete without ripple, a clip switched off at the end, and a
subtitle cue sitting past the end of the footage. Every one of them was
compiled into real generated black and welded onto the delivery. So
`trackDuration` stops at the last item that is not a gap, because a gap
between two clips is a length and a gap after the last one is the absence of
one, and `programmeDuration` is the last frame carrying picture or sound,
which is what `compile` builds to and what the export dialog shows. When the
timeline still runs past it, because a cue or a disabled clip is genuinely
drawn there, the export says so with both numbers rather than leaving it to be
noticed at the end of a render. `playingTracks` lives in `document.ts` and the
compiler imports it: which tracks play is one rule, and two copies of it would
make a file as long as one of them and as full as the other.

**`ffmpeg/transcode` takes a width and a height and does not say what shape it
makes.** Letterbox, stretch and crop are all defensible readings of a width
and a height that do not match the input's, and the schema picks none. It
never came up while every export was 16:9 into 16:9, where the three are the
same answer; a reel is the first time they differ. So the compiler stopped
asking: `fitFrame` sets the delivery frame with a filter of ours, `contain` is
`decrease` plus `pad` and `cover` is `increase` plus `crop`, and the transcode
after it is handed a picture already at its own width and height. It runs
BEFORE the subtitle burn, because libass draws into the frame it is handed and
fitting afterwards shrinks the captions into the letterbox with the picture.
It is skipped only when the shape is provably already right: a step upstream
pinned the picture to the delivery frame (`Ref.frame`), or every clip in range
reports a size and all of them have the delivery's aspect. A clip that never
reported a size answers no, because the cost of a wrong yes is a stretched
delivery nothing catches and the cost of a wrong no is one encode.
`npm run check:delivery` compiles every destination the dialog offers, at both
fits, and puts each graph to the server's validate, which stores nothing and
is free. `npm run prove:vertical` renders two of them small and reads the top
of the frame back: contain has a black bar there and cover does not, and
either check alone would pass on a stretched picture.

**Widening `TrackItem` does not fail everywhere it should.** Adding `Caption`
made every place that assumed a closed union fail to compile except
`itemDuration`, which fell through to `ZERO` and silently turned every caption
into a transition. Exhaustive switches, not fall-through defaults, in anything
that reads `item.kind`.

**A card's `pipelineId` is a claim about someone's account, and
`npm run cards` is what checks it.** Three of the four pipeline cards were
broken in ways nothing could catch: two named `tpl_subs` and `tpl_words`,
which are not ids but placeholders nobody replaced, and one bound
`{input: key}` to a pipeline whose only input node is named `video`, which
the server answers with "the request body does not match this pipeline" and
no hint as to which key. Reading a pipeline is free, so the check runs
offline of any spend and exits non-zero. `/api/runs` runs the same check
before it starts anything.

**A port is not a field.** `whisperx/subtitle` declares a `segments` out
port, and a run's reply does not contain it: a port is a wire inside a graph.
The two published subtitle pipelines wire only `files`, `text` and `language`
to their outputs, so the sentence timings exist in exactly one place, the
`.json` the run wrote. That is why the plan language has `read-json`.

**A card must claim a phrase to win.** Free-text overlap can rank candidates
but can never elect one. Without that rule "what is the weather like" routes to
whichever card happens to share a word, and deleting a card's vocabulary does
not stop it winning. A card's `match:` list, plus the quoted examples in its
`## When to use it`, is its claim; a card that claims nothing stays silent.
Silence is the right answer more often than a confident guess.

**A wait for a job is a function of what the job is doing.** Import waited a
flat 180s for a playable copy. A ten minute video needed 204s, succeeded, and
was thrown away twice: the proxy sat finished in storage while the clip went
into the pool unable to play, and pressing play moved the clock and nothing
else, because with no proxy the viewer has only the eight extracted stills.
`proxyBudgetMs` scales the wait with the media's own length. A constant
timeout on a job whose length is proportional to its input is a bug waiting
for a big enough input.

**The API key is server-only.** `EDITOR_API_KEY` never gets a `NEXT_PUBLIC_`
prefix and never reaches a client component. All calls go through route
handlers under `app/api/`.

**Do not call mutating endpoints casually.** `run_operation`, `run_pipeline`,
`PUT /v1/pipelines/{id}`, `publish`, and the pod-lifecycle operations
(indicspeak train/load/unload, whisperx load/unload, all of strix) cost money
or change the account's state. `POST /v1/pipelines/validate` stores nothing and
is free, use it freely.

**A test that asserts the shape of an edit is not a test.** Apply the batch with
`applyEdits` and assert on the document that comes out. Two of the eight worst
defects in this repo shipped past a green suite because the tests checked that an
op builder returned plausible-looking ops, never that applying them produced the
timeline the user was promised. One of them meant 15 of 18 clips could not be
deleted at all.

**A comparison of nothing passes.** Any test that walks a directory, parses a file
or diffs two tables must first assert it found something to compare. Otherwise a
rename turns the test into a no-op that reports success forever.

## Commands

    npm run dev         # next dev
    npm test            # node --test over test/*.test.ts
    npm run typecheck   # tsc --noEmit
    npm run catalogue   # regenerate lib/editor-api/catalogue.generated.ts from the live API
    npm run intel       # regenerate lib/intel/cards.generated.ts from cards/*.md
    npm run xcheck      # confirm offline preflight still agrees with the server
    npm run prove:selection  # drive clicking, deselecting and band-select in a real browser
    npm run prove:layers     # read the pixels back: a gap in V2 shows V1, not black
    npm run prove:export     # render, then count the frames in the file
    npm run prove:session    # remove a file, refresh the page, and see the project survive
    npm run cards            # every card's pipeline exists and takes what the plan binds
    npm run prove:captions   # a caption reaches the rendered pixels
    npm run prove:caption-font      # Hindi comes out as words, not as boxes
    npm run prove:caption-playback  # press Play: the cues are on screen, in order
    npm run prove:caption-edit      # drag a cue, pull its edge, retype its words
    npm run check:delivery   # every export destination compiles, on both sides, free
    npm run prove:vertical   # a 16:9 cut as a 9:16 reel: bars for contain, none for cover

Edit an intel card in `lib/intel/cards/*.md`, run `npm run intel`, then
`npm test`, the eval suite runs the real router over 15 things a person would
actually say and will tell you if the edit that fixed one phrase broke two.

`catalogue.generated.ts` is committed on purpose: the router, validator and
compiler must be buildable and testable with no network. Regenerate it when the
server gains operations, and re-run `npm test` afterwards, the tests assert
against real catalogue facts (116 nodes, 10 engines) and will tell you what moved.

## Design

Tokens live in `app/globals.css` and follow AI Suite: a true black ground,
surfaces barely lifted off it, and shape carried by hairlines **lighter** than
the fill. Red is the action colour, selection, focus, the active thing. Blue
is for data (charts, waveforms) and never for chrome. The semantic colours from
Resolve are load-bearing, not decorative: red playhead, amber dynamic trim,
green active trim point.

<!-- END:cutroom -->
