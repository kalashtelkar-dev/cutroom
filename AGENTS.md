<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes, APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

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
    npm run prove:caption-playback  # press Play: the cues are on screen, in order

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
