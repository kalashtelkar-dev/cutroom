# Cutroom

An AI video auto-editor for AISuite. Generated footage goes in, an edited
timeline comes out, and a Resolve-class NLE is there to correct it by hand.

```
npm install
cp .env.example .env.local     # EDITOR_API_URL and EDITOR_API_KEY
npm run dev
```

Then open one of these. The root page is a self-report, not the product.

| | | |
|---|---|---|
| **Editor** | [`/edit`](http://localhost:3000/edit) | the NLE: media pool, viewer, timeline, inspector, assistant |
| **Workbench** | [`/workbench`](http://localhost:3000/workbench) | router bench, intel card editor, evals, pipeline inspector |
| Foundations | [`/`](http://localhost:3000/) | the catalogue, time model and preflight checker reporting on themselves |

The editor opens the same workbench over your cut from **View ▸ Tool Caller
Workbench**, or with Alt+D, and Escape closes it back onto the timeline.

## What works, and what does not

[`ROADMAP.md`](ROADMAP.md) is the honest version: what is missing, why, and in
what order. Every gap in it was found by reading the code or by driving the
app, not by guessing.

The short version: importing, editing, saving, opening, the compiler and
**export** all work against the live API. `npm run prove:export` renders a
two-cut timeline over a music bed and checks the frame count is exactly the
sum of the clip durations: 120 frames, 5.0s at 24fps, zero drift.

## Where things are

| | |
|---|---|
| `lib/time/frames.ts` | integer-frame time model, rates as exact rationals, half-open ranges, SMPTE timecode incl. drop-frame |
| `lib/editor-api/catalogue.generated.ts` | 116 nodes from `GET /v1/pipelines/nodes`, ports, arities, full param schemas |
| `lib/editor-api/catalogue.ts` | queries over it: port surface, fan-out arity, param validation |
| `lib/editor-api/graph.ts` | the graph format, and the compiler's diagnostics answered offline |
| `lib/editor-api/client.ts` | the REST client, server-only, grouped by what a call costs you |
| `lib/intel/cards/*.md` | one card per tool: vocabulary, guidance and the typed plan, in one file |
| `lib/router/` | retrieval and planning, arithmetic, so the eval suite can run it |
| `lib/timeline/` | the document: derived positions, atomic edits with inverses, OTIO round-trip, validation, undo |
| `lib/compiler/` | timeline to pipeline graph, with content-addressed caching |
| `lib/executor/` | SSE parsing, event folding, scheduling with per-engine caps, retry classification |
| `lib/jobs/` | every action is a job with a timestamped log |
| `lib/commands/` | one registry for the menu bar, the keyboard and the toolbar |
| `lib/media/` | import, upload with progress, thumbnails, drag and drop planning |
| `lib/project/` | save, save as, open, and the stale-write refusal |
| `components/` | the NLE: timeline, viewer, inspector, tool rail, assistant, menu bar, jobs, workbench |
| `app/edit` | the editor |
| `app/workbench` | the workbench |
| `app/api/` | 10 route handlers, the only things that hold the API key |
| `test/` | 569 tests over 20 files, against real catalogue data |

## Commands

```
npm run dev         next dev
npm test            569 tests, node --test
npm run typecheck   tsc --noEmit
npm run smoke       drive the real build through Chrome and check what a person sees
npm run prove       spend real money: build media, compile, run, download an MP4
npm run prove:export  the whole export chain, timeline to playable file
npm run fixtures    make the real media the media harness imports
npm run prove:media   import real files through the real app, look at the pixels
npm run catalogue   regenerate the node catalogue from the live API
npm run intel       regenerate the intel index from lib/intel/cards/*.md
npm run xcheck      confirm offline preflight still agrees with the server
npm run agents      what the background agents are doing
npm run tidy        find dead files and unused exports
```

`npm test` and `npm run typecheck` prove the code agrees with itself, which is
not the same as it working. `npm run smoke` opens the app and uses it, and
`npm run prove` calls the live API. Both of those exist because every defect
that mattered here was found by a person using the app, not by a test.

## Notes on the API

The MCP surface is a facade over a 156-path REST API. Things worth knowing
before planning against it, each learned by calling the endpoint rather than
by reading the spec:

- **There is no renderer.** Nothing turns a stored timeline into video;
  `otio/export` emits EDL/FCPXML/AAF only. The timeline to graph compiler is
  ours, and it is the core piece.
- **There is no `GET /v1/pipelines`.** You can fetch, validate, save, publish
  and export a pipeline by id, but listing is only on the MCP surface, so we
  keep our own index.
- **A pipeline cannot be created by `PUT`.** `PUT /v1/pipelines/{id}` demands
  an `If-Match` etag even for an id that does not exist yet. New pipelines
  come from `POST /v1/pipelines/import`, whose body is one exported document:
  `{kind: "editor-api/pipeline", formatVersion: 1, source, name, description, graph}`.
- **`ffmpeg/custom` takes at most two wired inputs**, whatever its args
  declare. The compiler folds audio mixes pairwise because of it.
- **An operation is a job at `/v1/jobs/{id}`; a published pipeline is a run at
  `/v1/runs/{id}`.** Different resources, different ids, and asking the wrong
  one answers 404 rather than saying which you meant.
- **`ffmpeg/compose` cannot blend.** It arranges cells: grid, split, pip,
  stack. No alpha, no modes. Blending two picture tracks is `ffmpeg/custom`
  plus ffmpeg's `blend` filter, which takes the two wired inputs custom
  allows. Placeholders there are `{in0}` and `{in1}`, zero indexed.
- **Every output of `ffmpeg/thumbnail` is a frame.** It tags them all
  `role: "poster"`, so filtering posters out discards the entire filmstrip.
  That filter is right for `ffmpeg/custom`, which emits one poster beside the
  real file.
- **Only `output/` keys can be signed.** An upload lands under `input/`, and
  `POST /v1/outputs/sign` refuses those with "no asset was recorded". No
  endpoint signs an upload key, so anything that will be SHOWN has to pass
  through an operation first: `ffmpeg/thumbnail` for video, `imagemagick/resize`
  for a still.

`CLAUDE.md` has the full list of what was assumed and what turned out to be
true, and `AGENTS.md` has the rules that are easy to break.
