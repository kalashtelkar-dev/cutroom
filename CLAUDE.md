@AGENTS.md

# House rules

## No em-dashes. Anywhere.

Not in UI copy, not in code, not in comments, not in commit messages, not in
generated content, not in intel cards. This is absolute and it is easy to
break by habit, so check before you finish:

    grep -rn "$(printf '\u2014')" --include="*.ts" --include="*.tsx" \
      --include="*.css" --include="*.md" . | grep -v node_modules

That command must return nothing. Use a colon, a comma, or a full stop. Reach
for the full stop first: most em-dashes are two sentences wearing a trench
coat. `test/house-rules.test.ts` enforces this, including JSON files, where
one can hide as an escaped `\u2014` and be invisible to a scan of the bytes.

En-dashes in numeric ranges (30-80s) are fine as plain hyphens. Do not
substitute an en-dash for an em-dash; that is the same problem with a shorter
line.

# Mistakes made on this project, and the rules that come from them

Written down because I made all of these, several more than once. They are in
rough order of how much time they cost.

## 1. Guessing at an API contract instead of calling it

Nine separate bugs, every one of which died within seconds of actually
issuing the request. None of them could have been caught by any test.

| What I assumed | What is true |
|---|---|
| `ffmpeg/custom` takes `args` as a command string | `args` is argv, an array, one token per element |
| An operation's result is at `/v1/runs/{id}` | That is a pipeline RUN. An operation is a JOB, at `/v1/jobs/{id}` |
| `outputs/sign` returns an array of urls | It returns `urls` as an object keyed by object key |
| `pipelines/validate` returns `{issues}` | It returns `{errors, unfinished}`, split on purpose |
| `POST /v1/uploads` takes `{filename, contentType}` | It takes `{filename}` and REJECTS any other key |
| A presigned PUT can carry a Content-Type | The URL signs `host` alone; any extra header breaks the signature |
| `POST /v1/timelines` can be called empty | `name` is required |
| Graph nodes have an optional `position` | Required. Without it the graph is refused before it compiles |
| An input node's `required` is optional | Required, and it must be a boolean |
| `ffmpeg/concat` with `reencode: true` normalises its inputs | It normalises nothing. Every input must already carry BOTH a picture and a sound at one size, so audio-only, video-only and two sizes all exit 234 |
| `blend` of two 144 frame layers gives 144 frames | It gave 143. Hold the last frame with `tpad` and cut with `-frames:v`: a cap is not a floor |
| A six second AAC bed is six seconds | 6.036854s. Packets are 1024 samples, and `audio-replace` keeps the longer stream, so the picture came out a frame long |
| An unbound `$name` in a plan is caught somewhere | It is posted verbatim. `$program` reached the API as seven characters and came back `input_unreachable` |
| `$selection` is what a pipeline reads | It is a clip id. It resolves, it is a real string, and it is not a file. `$source` is the key |
| An operation's progress can be streamed like a run's | It cannot. `/v1/jobs/{id}/stream` is not a route, and a job id put to the run stream answers `no run "..."`. A job is polled |
| `whisperx/translate` translates | Only if you name a model that can. Default model: status `succeeded`, and the text comes back in the SOURCE language. No error, no flag. `model: large-v3` translates |
| ...and its output is usable as subtitles | It answers `alignSkipped` and ONE segment for the whole clip, which is one caption on screen for the length of the programme |
| `vllm/translate` "keeps every timing" | It keeps the span and re-divides inside it, freely, in both directions: four aligned cues came back as one, one came back as three, and one run came back empty. `system` is what holds it to the segments it was given |

**The rule: anything that touches the API is verified by calling it, before
saying it works.** Not typechecked. Not unit tested against a fake. Called.
`npm run prove` exists for this.

## 1b. Checking the wrong object, in both directions at once

`checkRunBody(bound)` was handed the whole BINDINGS object instead of the body
the step was about to post. The shell seeds `selection` with the selected
clip's id for local timeline ops, no plan has ever asked for it, and so every
subtitle run died before it started with `selection: clp_tevzon7u is an id
inside the document, not a file in storage. Use $source.` Every word of that
was true and the key was not in the request.

The same line was vacuous the other way. `checkOperationInput` only looks at
ports the input actually carries; the bindings carry no port called `input`;
so the check that refused pipelines falsely never fired on an operation at
all. One expression, a false positive on one kind of step and a silent no-op
on the other, and both were invisible to a suite of 1000 tests because the
tests passed `$src`, bound by nothing, to a fake that did not care.

**The rule: a check on what you are about to send is a check on WHAT YOU ARE
ABOUT TO SEND.** Not on what you know. If the object under test is not the one
that goes on the wire, it is not that check.

## 2. Verification that proves the code agrees with itself

The import pipeline had 13 passing tests and a clean typecheck while being
completely broken end to end, because every test used a fake transport that
did exactly what I had assumed the real one did. A test written from the same
wrong assumption as the code will always pass.

Three more of the same shape:

- **A test that asserts the shape of an edit is not a test.** Two op builders
  shipped past a green suite producing batches that corrupt or throw. One of
  them meant 15 of 18 clips could not be deleted at all. Apply the batch with
  `applyEdits` and assert on the document that comes out.
- **A comparison of nothing passes.** A drift test nearly became a permanent
  no-op because it would have compared zero entries after a rename. Assert you
  found something to compare before comparing it.
- **A fake that cannot fail teaches nothing.** If the double always succeeds,
  the test only proves the happy path exists.

## 2b. A fake transport cannot 404

The executor ran operations through a fake that answered whatever it was
scripted to answer, and `browserTransport`'s operation path had never been
run by anything, because every card in play ran a pipeline. A pipeline is a
RUN and has a stream; an operation is a JOB and has none. The first card to
run an operation asked for the stream of a run that does not exist, got a 404,
and left a job on the queue with nothing reading it.

`npm run prove:assistant-ask` and `npm run prove:subtitle-language` exist
because of this: one drives the panel with a real pointer, the other runs the
card's own plan through the real transport against the live API.

## 3. Saying "finished" without adversarial review

I reported a build as complete and under test. An adversarial review pass
found **8 broken and 20 wrong** defects in it, including a run loop that never
terminated and a document corruption that made saved projects permanently
unreadable. The tests passed. They passed *over* the bugs, which is worse than
failing.

**The rule: "done" means someone hostile looked for the reason it is not.**

## 4. Shipping the UI ahead of the thing it triggers

I built a menu bar, a tool rail, a command palette, a theme and a workbench
before Import, Save, Open or Export did anything. The first button the user
pressed failed with an empty error message.

**The rule: a control that does not work yet should not be in the interface,
or must say plainly that it does not work. Build the function, then the
affordance.**

## 5. An error that does not say what went wrong

A plain `Error` escaped to Next's default handler, which returns an empty
body. The browser reported `could not get an upload url:` with nothing after
the colon. That wasted a round of debugging for no reason.

**The rule: every route handler catches everything and returns the reason.
Never let a thrown Error become an empty 500.**

## 6. Shipping sample data as someone's starting state

`/edit` opened holding a demo project full of invented footage. An editor that
starts with someone else's material is asking you to delete it before you can
begin. Fixtures are for tests.

## 7. Assuming instead of reading what was already there

- `InPort.list` and `bindable` were typed from memory. Both were wrong, and
  the second meant a validation branch could never fire.
- Module-level counters made `demoProject()` return different ids on a second
  call. That kind of thing survives every test and then breaks a reset button.
- Markers were written in seconds, so every one sat a frame off the cut it
  marked. **Frame positions are the sum of integer durations, which is NOT the
  same number as converting the summed seconds.** 3.4s + 6.2s is frame 231;
  `round(9.6 x 24)` is 230.

## 8. Telling the user to run a command that does not exist

I said to use `/workflows` three times. It is not in this build. Do not
recommend a command without confirming it exists. `npm run agents` was written
because of this, and it does exist.

## 9. A rule with a hole in it is not a rule

My own em-dash check missed one hidden in package.json as `\u2014`. A rule
worth having is worth enforcing in a test, and the test is worth attacking.

Three more of exactly this shape, all found later by attacking them:

- **The em-dash test never read Markdown.** `EXTS` was `.ts .tsx .css .json`,
  while the documented grep has always included `*.md`. Four em-dashes walked
  into ROADMAP.md past a green suite, and `npm run tidy` had been able to
  rewrite the em-dashes out of CLAUDE.md, the document that defines the rule.
- **`npm run xcheck` exited 0 whatever it found.** AGENTS.md claimed offline
  preflight "is checked to match the server's"; nothing checked, a human had
  to read the table. A case named `clean:` sat in it for a long time not
  compiling on either side and the run still reported success.
- **`prove:layers` hand-wrote its own copy of the filter the compiler emits.**
  A green run therefore did not prove the compiler's filter worked. It now
  imports `HOLD_LAST` from `compile.ts`, so at least that part cannot drift.

## 10. A setter with no caller is not a feature

`recordCostMetric` and `recordReencodeMultiplier` existed, were exported, and
were called by nothing but their own test, which called the setter and then
read it back. That test passes forever and proves nothing. Meanwhile the
ROADMAP said the cost model was "calibrated dynamically" and every estimate a
user saw was the number somebody typed.

**The rule: if a mechanism is claimed to be connected, one test asserts the
connection exists,** by reading the calling module if there is no cheaper way.
`lib/compiler/calibrate.ts` now measures the run the export just did, and
`test/cost-model.test.ts` fails if `render.ts` stops calling it.
