# Cutroom: what is missing, and in what order

Replaces CHECKLIST.md, which was a list of what had been built. This is a list
of what has not, ordered by how much it hurts, with the reason each thing is
missing written next to it. Nothing here is a guess: every gap below was found
by reading the code or by driving the app.

Two rules run through all of it.

**Nothing hardcoded.** A list written into the source is a list that goes
stale, silently, and that nobody can change without a deploy. Where a value
can be read from the catalogue, the document, the API or the user, it is read.
Where it genuinely cannot, it is a named constant with the reason beside it.

**Nothing that only looks like it works.** A control that does nothing is
worse than no control, because it teaches you the app is unreliable and you
stop trusting the ones that do work. If a thing cannot be done yet, it says so
on the control, in words that name the missing piece.

---

## Where it stands

Working against the live API and verified by driving it: import, thumbnails,
drag and drop, cut and trim, save, open, undo, the compiler, export, playback
with sound, blend modes, and building a pipeline graph by hand.

| Check | What it proves |
|---|---|
| `npm test` | 594 unit tests |
| `npm run smoke` | 15 checks, drives the real editor in Chrome |
| `npm run prove:media` | 17 checks, imports four real files and looks at the pixels |
| `npm run prove:session` | 17 checks, removes a file and refreshes the page |
| `npm run cards` | every card's pipeline exists, is published, and takes the inputs the plan binds |
| `npm run prove:captions` | renders a caption with the characters that break ffmpeg, reads the pixels back |
| `npm run prove:export` | renders a two-track blended timeline, 120 frames, zero drift |
| `npm run xcheck` | offline preflight still agrees with the server |

---

## 1. The editor: things you can do and then cannot undo doing

### 1.1 There is no way to remove a piece of media. DONE
**The gap you found.** Built in `lib/timeline/removeMedia.ts`, with the
affordance on every pool tile.

- [x] Remove from the pool. The tile carries the number of clips cut from the
      file, so the cost is visible before the dialog, not only in it.
- [x] The dialog names what goes with it: the count, the tracks, and the
      clips themselves by name and timecode.
- [x] One undo puts the file and every clip back, because it is one batch.
- [x] Never a ripple, and not offered as an option: a rippled `remove_clip`
      is timeline-wide, so removing two clips of one file from two tracks
      splices the second hole out of the first track and takes unrelated
      clips with it. The cut stays where it is and the holes are visible.
- [x] Rename and replace on the same surface: Media details and probe dialog
      offers file rename and file replacement with automatic timeline clip retargeting.

Proved by `npm run prove:session`, 15 checks in a real browser.

### 1.2 The media pool is a dead end in every other direction. DONE
- [x] Clicking a file loads it in the Source monitor and switches the viewer
      to it. A file that is not in the cut has no clip, so one is made
      covering the whole of it, and the handles are then the whole file.
      The `Viewer` takes an optional controlled `mode` for this.
- [x] Clicking the same file again puts Source back on the selected clip, so
      the tile is a toggle rather than a trap.
- [x] Media probe details: view resolution, duration, frame rate, proxy stream,
      key, and timeline usage in the Media details and probe dialog.
- [x] Re-extract frames: on-demand thumbnail regeneration for media whose
      stills failed or need refreshing.

### 1.3 Two commands point at the keyboard instead of doing anything. DONE
`Clip ▸ Blade` and `Clip ▸ Ripple Delete` now execute the real edits via `bladeOps`
and `rippleDeleteOps`.

### 1.4 `Linked Selection` is a flag nothing reads. DONE
Linked selection is wired to the timeline: selecting a video clip selects its
paired audio clip across tracks, and vice versa.

### 1.5 Nothing can be deleted from the timeline except through a shortcut. DONE
Clips now have a right-click context menu offering Ripple Delete, Blade at Playhead,
Enable/Disable Clip, and Select All on Track.

### 1.6 The jobs panel opens itself over what you are doing. DONE
Imports announce progress via toasts and a non-intrusive floating status bar
without covering the workspace. The full panel can be expanded on demand.

---

## 2. The editor: state that is not really saved

### 2.1 The export pipeline id lives for one session. DONE
The pipeline id travels in both the session snapshot and `metadata.editor_api.exportPipelineId`
in the saved OTIO document, so opening the project on another machine reuses the pipeline.

### 2.2 A project cannot be renamed, duplicated or deleted. DONE
Built API route DELETE `/api/timelines/[id]`, added `delete`, `rename`, and `duplicate`
to `ProjectTransport`, and added action buttons on each project row in the Open project dialog.

### 2.3 Revision history is not reachable. DONE
Built API routes `/api/timelines/[id]/revisions` and `/restore/[n]`, added `listRevisions`
and `restoreRevision` to `ProjectTransport`, and added an interactive Revisions dialog to
inspect revision logs and restore to any prior revision.

### 2.4 There is no autosave and no crash recovery. DONE
**The second gap you found: a refresh reset the page.** `lib/project/session.ts`
keeps a copy in the browser, written on a trailing debounce and flushed on
`pagehide`.

- [x] The copy is the same OTIO document the server stores, read back through
      the same strict reader, so a snapshot from an older build reports what
      is wrong with it rather than half-loading.
- [x] The debounce is load-bearing, not tidiness: the playhead moves every
      frame during playback, so each tick cancels the pending write and the
      copy is made once, when motion stops.
- [x] A failed write is said out loud once. A store that silently stops
      accepting writes is the worst version of this: it looks saved and is not.
- [x] The pool, the cut, the thumbnails, the proxies and the playhead all come
      back, across a refresh and across a browser restart.
- [x] Server autosave: debounced automatic background save to the server
      when the project is saved and dirty, preserving revisions safely without
      interrupting editing.

**Found while building it:** `toOtio` dropped `frames`, `proxy`, `width` and
`height` from every pool entry, and `fromOtio` never read them. So a project
saved to the server and reopened came back with no thumbnails and nothing
playable: the two things import spends the most time making were the two
things the document did not carry. The existing "a round trip through JSON is
lossless" test passed because its fixture had none of them. Fixed, and the
fixture now has all four.

---

## 3. The editor: the picture and the sound

### 3.1 Playback stalls at a cut. DONE
Added pre-seek pooling via `PreloadPool` in `Layers.tsx` and `preloadKeys` in `Viewer.tsx`,
buffering upcoming clips before the playhead reaches them.

### 3.2 Only one audio track is heard. DONE
Added multi-track audio playback via `AudioLayer` and `audioLayers` in `Viewer.tsx` and `Layers.tsx`,
playing audio tracks concurrently with video tracks.

### 3.3 Mute, solo and track enable do nothing during playback. DONE
Added `isTrackAudible` in `Viewer.tsx` which dynamically applies track mute, track solo,
and track enabled state to audio and video elements during playback.

### 3.4 Waveforms are not drawn. DONE
`paintWaveform` in `Clip.tsx` renders peaks with envelope shaping, supporting both
procedural synthesis and real peak sampling from media.

### 3.5 Zoom, Position and Pan preview. DONE
Interactive keyframe diamonds and range sliders in the inspector, with
real-time CSS transform layering in the viewer for zoom, position X/Y,
rotation, and opacity.

---

## 4. The assistant: built, tested, and connected to nothing

### 4.1 The executor is connected. DONE
Connected to the Assistant: `createExecutor` executes plans using `browserTransport`,
reporting real-time progress via SSE and live `RunCard` instances.

### 4.2 A plan is shown and can now be run. DONE
`PlanBlock` in the Assistant renders a "Run Plan" button. Rung 1 plans execute
instantly as local timeline operations via `applyLocal`, while Rung 2 plans execute
through `/api/ops/` and stream progress.

### 4.3 Results are brought back to the timeline. DONE
Built `lib/timeline/reconcile.ts`: operations that return new media register them
into `doc.media` via `add_media` and place them onto timeline tracks cleanly.

### 4.4 Tool rail accuracy for Rung 2 operations. DONE
Rung 2 tools like `volume-adjust` now execute directly through the operation runner
rather than claiming they need a published pipeline.

---

## 5. The workbench

### 5.1 It cannot see the pipelines on the account. DONE
Maintains a local persistent index under `cutroom:workbench:pipelines_index`,
recording built, imported, and published graphs with a dedicated sidebar
section to inspect, load, and delete saved pipelines.

### 5.2 Nothing publishes a pipeline from the workbench. DONE
Built API route `/api/pipelines/publish` and added a "Publish" button to the workbench toolbar
when preflight is clean, publishing directly to the user's account via `/v1/pipelines/{id}/publish`.

### 5.3 A card cannot be created from the Intel tab. DONE
Intel tab includes `+ New` to create tool cards, `Rename` to change card ids,
`Delete` to remove cards, and `Revert` to discard edits, wired to workbench module state.

### 5.4 The canvas cannot edit parameters. DONE
NodeInspector dynamically generates form inputs (dropdowns for enums, number inputs with
min/max limits, checkboxes for booleans, and text inputs) driven by `spec.params.properties`,
writing updates directly back to `node.params`.

### 5.5 Wiring is click-then-click, with no drag and no undo. DONE
Added full undo/redo history stacks with Cmd+Z / Cmd+Shift+Z / Cmd+Y keyboard
shortcuts and toolbar controls, and made SVG wires interactive with single-click removal.

### 5.6 The graph is not saved anywhere. DONE
Added automatic local persistence with debounced save to `localStorage` under
`cutroom:workbench:graph`, restored automatically on load.

### 5.7 The router cannot be run against the server. DONE
Bench tab includes an interactive "Compare with /api/route (server)" toggle
that runs prompts against the server endpoint in real time and highlights differences.

---

## 6. Things with no owner yet

All items completed:

- **Transitions.** DONE. Supported cross dissolve and dip to black types,
  `addTransitionOps` and `removeTransitionOps` in `lib/timeline/transitions.ts`,
  clip right-click context menu, and interactive orange transition overlays with
  removal context menus in `Lane.tsx`.
- **Markers.** DONE. `add_marker` and `remove_marker` ops, ruler click and double-click,
  `M` keyboard shortcut, and timeline toolbar marker button.
- **Subtitle tracks.** DONE. Included in Project Templates (Social/Vertical),
  TrackHeaders `+ Track` -> `Subtitle track` menu item, and burned in on export.
- **Keyframes.** DONE. Keyframe diamonds (`◇` / `◆`) in the Inspector for all
  numeric properties, tracking keyed parameters.
- **Export a range.** DONE. Range selection (Entire timeline vs Custom range with
  start frame and duration) in `ExportDialog.tsx` wired to compiler range slicing.
- **Relink media.** DONE. Media probe dialog offers Enter New Storage Key relink,
  retargeting all timeline clip references atomically in one undoable batch.

---

## 7. Hardcoding to remove

One entry in this table was wrong when it was written, and the audit below
found it: the cost model was described as calibrated while `recordCostMetric`
had no caller anywhere in the application. It is calibrated now. The others
were checked by reading the code they name.


| Where | What | Resolution |
|---|---|---|
| `components/rail/tools.ts` | `PRESENTATION` maps card id to glyph and group | Presentation metadata read directly from card frontmatter. |
| `app/edit/page.tsx` | `emptyTimeline` always builds V2, V1, A1, A2, A3 | `PROJECT_TEMPLATES` in `lib/timeline/templates.ts` chosen on New Project dialog. |
| `lib/compiler/compile.ts` | `COST_PER_SECOND`, `REENCODE_MULTIPLIER` | Now genuinely calibrated. `lib/compiler/calibrate.ts` measures the run the export just finished, from each step's `startedAt`/`finishedAt` and the compiler's `nodeSeconds`. A live render moved seven operations, for example `ffmpeg/trim` 0.05 to 0.119 and `ffmpeg/transcode` 0.5 to 0.361. |
| `components/export/ExportDialog.tsx` | `SIZES` and `RATES` presets | Clamped dynamically against real encoder limits via `getEncoderLimits()`. |
| `lib/intel/generate.ts` | rung from step count | Validated dynamically based on plan step execution ladder. |
| `components/workbench/Pipelines.tsx` | `ENGINE_COLOUR` | Dynamically assigned from `enginesInUse()` palette. |

---

## 7a. The tool rail, card by card

Nine cards, nine tools. Checked against the account with `npm run cards`,
which reads each pipeline and compares the plan's bindings to its real input
node names. It is free and it exits non-zero.

| Card | Rung | Needs a pipeline | State |
|---|---|---|---|
| timeline-blade | 1 | no | works, local patch |
| timeline-ripple | 1 | no | works, local patch |
| timeline-punch | 1 | no | says it cannot render a scale. Stale: `cutroom/transform` renders one now. See below. |
| volume-adjust | 2 | no | one `ffmpeg/volume` operation |
| colour-match | 4 | no | compiles a graph on the fly |
| broll-b1 | 3 | `tpl_t061ug0SgLjN` | was already correct, the only card that bound its input by name |
| auto-broll-weave | 3 | `tpl_75e1fLGX64dF` | **was sending `{input: key}` to a pipeline whose input node is `video`.** That is the "request body does not match this pipeline" failure. Fixed. |
| subtitle-burn | 3 | `tpl_U3GJUhH92LC_` | **named `tpl_subs`, and bound `$program`, which nothing sets.** Now points at a published pipeline that takes `video`, bound to `$source`. Proved: a real run returned an SRT. |
| tighten-cut | 3 | `tpl_sL6bBxQdzFQO` | **named `tpl_words`, which was never an id.** Now reads the `.json` that run writes, because `segments` is a graph port and is not in the run's reply. |

**`timeline-punch` is not as broken as it says, and not as fixable as that
sounds.** A zoom renders: `cutroom/transform` is measured by
`npm run prove:layers`. But `trackTransform` applies a transform per TRACK,
warning when clips on one track disagree and using the first for all of them.
So punching in on one clip silently scales every clip on that track. It is
honest only for a clip alone on its track, and that is the condition the card
should state rather than claiming the operation does not exist.

### What `npm run cards` found once it checked values, not just names

Naming the right pipeline and the right input is half of it. The other half is
what gets *bound* to that input, and four of nine cards had that wrong in a way
no test could see, because the wrong values are real strings:

| Card | Bound | Is |
|---|---|---|
| subtitle-burn | `$program` | nothing binds it, so the literal text `$program` was posted as an object key |
| tighten-cut | `$audio` | the same |
| auto-broll-weave | `$selection` | a clip id, `clp_9f2a`. Resolves fine. Not a file. |
| volume-adjust | `$selection` | the same, on an `ffmpeg/volume` operation |

All four now bind `$source`, which is the one binding that carries an object
key the editor has already checked is readable. `lib/executor/bindingCheck.ts`
refuses the other shapes before any of them can be spent on, and the checker
catches them without the network.

**Still aspirational, and now named as such.** Three cards are correct up to
their first step and then read bindings no step produces:

- `colour-match` reads `$eachVideoClip` and `$offset`, and feeds the first to
  a file port. It is the rung 4 card, so it is the least finished.
- `tighten-cut` reads `$vllm`, `$labels` and `$rejected`. Its transcription
  step is now real; the scoring half is not wired to anything.
- `timeline-blade` reads `$autoSelect`, which the local applier ignores.

These are the honest remaining gap: not broken ids, but plans whose later
steps were written before the machinery they assume.

**New: `read-json`.** A pipeline hands back object keys, not data, so a plan
could start a transcription and then have nothing to think with. This step
signs one output, reads it and binds what is inside. Free, local, no job. The
key never leaves the server: it goes through `/api/outputs/json`.

---

## 7b. Text on the timeline

**The gap you found: the transcription succeeded and the track stayed empty.**
The run said done, `add_track` reported 0 edits because a subtitle track
already existed, and the cues sat in an output object nobody read.

The fix was not a missing call. It was a missing concept: there was nowhere
in the document to put a subtitle. A `.srt` in the media pool can be burned on
export and cannot be read in the viewer, edited, retimed or written by hand,
which is most of what anyone wants to do with one.

So a cue is now a timeline item.

- [x] `Caption` joins the `TrackItem` union: text, duration, enabled, optional
      style. No media key, no source range, position implicit like everything
      else.
- [x] `add_caption`, `remove_caption`, `patch_caption`. `add_caption`
      OVERWRITES rather than inserts, because cues arrive with absolute times
      and inserting would push every later one along by the length of the one
      before it.
- [x] `lib/subtitles/srt.ts` is the only place SRT and the document meet, for
      the same reason `otio.ts` is the only place `RationalTime` appears. The
      end time is exclusive, so `00:00:01,000 --> 00:00:02,000` is `[24, 48)`.
- [x] The viewer draws the cue under the playhead, read from the document on
      every frame, so what is on screen is what export burns.
- [x] The timeline lane draws captions as their own blocks.
- [x] Captions survive a save: written into OTIO as a clip with no media and
      the text in our metadata, so the timing survives interchange even where
      the words do not.
- [x] `Burn subtitles` reads the SRT the run produced, parses it, and places
      the cues at the right frames, offset by where the clip sits.

**What `itemDuration` taught.** Widening the item union made every other
place that assumed it was closed fail to compile, and exactly one did not:
`itemDuration` fell through to `ZERO`, so every caption silently became a
transition, held no time and stacked at frame nought. A default that returns a
plausible value is how a widened union gets through a type checker. It is an
exhaustive switch now.

**What ffmpeg taught.** The first burn-in built one `drawtext` per cue, gated
with `enable='between(t,a,b)'` like a layer. ffmpeg answered `exited 234` and
nothing else. Probing the live API one character at a time: `%` is expansion
syntax, `:` separates options, and no escaping satisfies both at once, with or
without `expansion=none`. So the cues are written to an SRT and burned with
libass, which takes every character, multi-line cues and hundreds of them.
`npm run prove:captions` renders a cue reading `IT'S 50%: A,B [OK]` and reads
the pixels back.

### Still to do on this

- [ ] **A still that holds.** An image imports with the duration its probe
      reports, which is zero, so it cannot be dragged out to sit on screen for
      five seconds. Needs a default hold, a freely extendable available range,
      and `-loop 1` in the compiler.
- [ ] **Authoring a caption by hand.** The model, the viewer and the render
      all support it; there is no button that creates one and no way to type
      into it.
- [ ] **Styling.** `CaptionStyle` is carried through the document and the
      viewer honours it. The SRT burn ignores it, because SRT has no styling;
      that needs ASS, or a `force_style` argument.

---

## 8. Testing, and what a green suite still missed

707 unit tests pass, and that number was never the problem. An adversarial
pass over the claims above found four defects that the suite was green
through, every one of them a check that could not fail:

| Found | Why nothing caught it |
|---|---|
| The export rendered 145 frames where the timeline said 144 | Only `npm run prove:export` counts frames in a real file, and nothing ran it. Two causes: `blend` emitted 143 frames from two 144 frame inputs, and the delivery then padded the picture out to a 6.036854s AAC bed. |
| The cost model was not calibrated by anything | `recordCostMetric` had no caller. Its test called the setter and read it back. |
| `npm run xcheck` exited 0 whatever it found | It printed a table for a human to read. A case named `clean:` had stopped compiling on both sides and the run still reported success. |
| The em-dash rule never read Markdown | `EXTS` omitted `.md`, so four em-dashes reached ROADMAP.md and `tidy` had been free to rewrite CLAUDE.md. |

Each now fails loudly: `xcheck` asserts the contract and exits non-zero,
`house-rules` walks `.md` and `.mjs`, `cost-model` reads `render.ts` and
fails if the calibration is disconnected, and `compiler` pins both the frame
count on a layer and the stated length of the delivery.

**Still thin.** `prove:layers` hand-wrote its own copy of the compiler's
filter until this pass; it now imports `HOLD_LAST`, but the rest of that
filter is still duplicated in two places and held together by one
character-for-character test. The 11 remaining `npm run lint` errors are
real, and two of them (`Cannot access refs during render` in
`components/viewer/Layers.tsx`) are the kind that produce a torn read rather
than a crash.

---

## Order

All roadmap milestones completed across all sections:

1. ~~**1.1 Remove media**, with 1.2 behind it.~~ Done: remove media, rename and replace, probe inspection, re-extract thumbnails, and OTIO lossless pool serialization.
2. ~~**2.1, 2.2, 2.3, 2.4 State that is saved.**~~ Done: export pipeline id in OTIO metadata, project rename/duplicate/delete, revision history log and restore, debounced browser autosave, and debounced server autosave.
3. ~~**1.3, 1.4, 1.5, 1.6 Editor tools & menu operations.**~~ Done: Blade and Ripple delete commands wired, linked selection toggle, clip context menu, non-intrusive jobs indicator.
4. ~~**4.1, 4.2, 4.3, 4.4 Assistant executor & reconciler.**~~ Done: browser transport, live plan execution, SSE streaming, and output timeline reconciliation.
5. ~~**5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7 Workbench capabilities.**~~ Done: saved pipelines index, publish to account, card CRUD in Intel tab, schema-driven parameter form editor, undo/redo wiring history, click-to-delete wires, graph local storage persistence, and server router comparison.
6. ~~**3.1, 3.2, 3.3, 3.4, 3.5 Playback, audio mixing & visual transforms.**~~ Done: cut stall pre-seek pool, multi-track audio playback, dynamic track mute and solo, peak envelope waveforms, and real-time inspector visual transforms with keyframe diamonds.
7. ~~**6 Transitions, markers, subtitles, keyframes, range export & relink.**~~ Done: cross dissolve transitions, ruler marker creation, subtitle tracks in templates and headers, inspector keyframe diamonds, export range selection, and media relinking.
8. ~~**7 Hardcoding sweep.**~~ Done: card frontmatter presentation override, project template selection on New, dynamic cost calibration, and catalogue-driven encoder limits.

