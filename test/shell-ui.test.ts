import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useFixtures } from './fixtures/cards.ts';

/**
 * The rail builds its tools FROM the intel cards, so these are tests of the
 * corpus as much as of the rail. The corpus under test is the fixture one:
 * `lib/intel/cards/` belongs to whoever is using the workbench and is allowed
 * to be empty.
 */
beforeEach(() => { useFixtures(); });
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RATES, frames, timeRange, toTimecode, type Frames } from '../lib/time/frames.ts';
import { findClip, timelineDuration } from '../lib/timeline/document.ts';
import { applyEdits } from '../lib/timeline/edits.ts';
import { demoProject } from '../lib/fixtures/project.ts';
import type { EditOp, MediaRef, PlacedItem, Track, TrackKind } from '../lib/timeline/types.ts';

import {
  buildTools, runsLocally, searchTools, toolContext, toolRung, toolWhy, trackFacts,
  type Tool,
} from '../components/rail/tools.ts';
import { putCard, resetCards } from '../lib/intel/index.ts';
import { buildCommands, type Actions } from '../lib/commands/registry.ts';
import { matchShortcut } from '../lib/commands/shortcuts.ts';
import {
  atEnd, clampToWindow, hasRoom, scrubFrame, sourceWindow, timelineWindow, trimMarks,
  windowFraction,
} from '../components/viewer/transport.ts';
import { fieldText, nextField, type FieldState } from '../components/inspector/numberField.ts';
import { isTyping, shellShortcut } from '../components/shell/shortcuts.ts';
import {
  fitTimelineHeight, RULER_HEIGHT, TIMELINE_MIN_HEIGHT, TIMELINE_TAIL,
  TIMELINE_TOOLBAR_HEIGHT, TRACK_HEIGHT, VIEWER_MIN_HEIGHT,
} from '../components/timeline/interactions.ts';
import { FALLBACKS } from '../components/ui/tokens.ts';

/**
 * The shell, the viewer, the inspector and the rail.
 *
 * The subsystem had no test at all, which is how a transport that could not
 * move the playhead and a number field that could not be typed into both
 * shipped. Everything testable without a DOM is tested here, and the three
 * things that are only structural (the viewer keeping no clock of its own,
 * the shell keeping one toast, the toolbar inventing no resolution) are
 * pinned by reading the source, in the same spirit as house-rules.test.ts.
 */

// fileURLToPath, not .pathname: the repo path contains a space.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const RATE = RATES.film;   // 24fps, so a frame is a frame
const F = (n: number): Frames => frames(n);

// ── the viewer's transport ──────────────────────────────────────────────

describe('viewer transport windows', () => {
  test('an empty timeline is nothing long, not one frame long', () => {
    const w = timelineWindow(F(0));
    assert.equal(w.duration, 0);
    assert.equal(w.first, 0);
    assert.equal(w.last, 0, 'there is nowhere to park, so first and last are the same frame');
    assert.equal(
      toTimecode(w.duration, RATE),
      '00:00:00:00',
      'the readout reconstructed from last + 1 said 00:00:00:01 for an empty timeline',
    );
  });

  test('the last frame you can park on is one before the duration', () => {
    const w = timelineWindow(F(240));
    assert.equal(w.last, 239, 'ranges are half-open: frame 240 is not in the timeline');
    assert.equal(w.duration, 240);
    assert.equal(toTimecode(w.duration, RATE), '00:00:10:00');
  });

  test('the demo project reads out its real length', () => {
    const doc = demoProject();
    const w = timelineWindow(timelineDuration(doc));
    assert.equal(w.duration, timelineDuration(doc));
    assert.equal(w.last, w.duration - 1);
  });

  test('Source scrubs the media, handles and all, not just the part the cut uses', () => {
    // 48 frames used out of 480 that exist, starting 96 in: 96 frames of head
    // handle and 336 of tail, which is the whole reason to open Source.
    const media: MediaRef = {
      key: 'm1', name: 'm1', kind: 'video', available: timeRange(F(0), F(480)),
    };
    const used = timeRange(F(96), F(48));

    const w = sourceWindow(used, media);
    assert.equal(w.first, 0);
    assert.equal(w.last, 479);
    assert.equal(w.duration, 480, 'the used range has no handles in it by definition');

    // and the position is a source frame, so the readout is source timecode
    assert.equal(clampToWindow(w, used.start), 96);
    assert.equal(toTimecode(F(96), RATE), '00:00:04:00');
  });

  test('Source falls back to the used range when the media is not in the pool', () => {
    const used = timeRange(F(96), F(48));
    const w = sourceWindow(used, null);
    assert.deepEqual([w.first, w.last, w.duration], [96, 143, 48]);
  });

  test('the in and out marks sit on the jog, not one frame past its end', () => {
    const media: MediaRef = {
      key: 'm1', name: 'm1', kind: 'video', available: timeRange(F(0), F(480)),
    };
    // a clip that runs to the very end of its media
    const w = sourceWindow(timeRange(F(432), F(48)), media);
    const marks = trimMarks(w, timeRange(F(432), F(48)));
    assert.equal(marks.in, 432 / 479);
    assert.equal(marks.out, 1, 'the last USED frame, not the half-open end');
    assert.ok(marks.out <= 1);
  });

  test('scrubbing rounds to a frame and never leaves the window', () => {
    const w = timelineWindow(F(240));
    assert.equal(scrubFrame(w, 0), 0);
    assert.equal(scrubFrame(w, 1), 239);
    assert.equal(scrubFrame(w, 0.5), 120, 'half of 239 is 119.5 and a frame is an integer');
    assert.equal(scrubFrame(w, -3), 0);
    assert.equal(scrubFrame(w, 9), 239);
    assert.equal(clampToWindow(w, 1000), 239);
    assert.equal(clampToWindow(w, -1000), 0);
  });

  test('an empty window has no room and no fractions to divide by', () => {
    const w = timelineWindow(F(0));
    assert.equal(hasRoom(w), false);
    assert.equal(windowFraction(w, F(0)), 0, 'zero span must not be a division by zero');
    assert.equal(scrubFrame(w, 0.7), 0);
    assert.equal(atEnd(w, F(0)), true);
  });

  test('a source window that starts partway into the media still maps to the jog', () => {
    const media: MediaRef = {
      key: 'm1', name: 'm1', kind: 'video', available: timeRange(F(100), F(200)),
    };
    const w = sourceWindow(timeRange(F(120), F(40)), media);
    assert.deepEqual([w.first, w.last], [100, 299]);
    assert.equal(windowFraction(w, F(100)), 0);
    assert.equal(windowFraction(w, F(299)), 1);
    assert.equal(scrubFrame(w, 0.5), 200);
  });
});

// ── the inspector's number field ────────────────────────────────────────

const ZOOM = { min: 0.25, max: 4 };
const SPEED = { min: 10, max: 400 };
const PAN = { min: -1, max: 1 };
const f = (digits: number) => (v: number) => v.toFixed(digits);

/** Type a string one keystroke at a time, as a person does. */
function typeAll(start: FieldState, text: string, bounds: { min: number; max: number }): FieldState {
  let s = start;
  for (let i = 1; i <= text.length; i += 1) {
    s = nextField(s, { t: 'type', text: text.slice(0, i) }, bounds);
  }
  return s;
}

describe('inspector number field', () => {
  test('a value below the control default can be typed', () => {
    // "0.5" starts as "0", which parses to 0 and clamps to the 0.25 minimum.
    // Clamping mid-word replaced the text with "0.250" and 0.5 was unreachable.
    let s: FieldState = { draft: null, value: 1 };
    s = typeAll(s, '0.5', ZOOM);
    assert.equal(s.value, 1, 'nothing is committed while the field is being typed into');
    assert.equal(fieldText(s, f(3)), '0.5', 'the field shows what was typed, verbatim');

    s = nextField(s, { t: 'commit' }, ZOOM);
    assert.equal(s.value, 0.5);
    assert.equal(fieldText(s, f(3)), '0.500');
  });

  test('a speed of 50 survives being typed, minimum 10 and all', () => {
    let s: FieldState = { draft: null, value: 100 };
    s = typeAll(s, '50', SPEED);
    assert.equal(fieldText(s, f(0)), '50');
    s = nextField(s, { t: 'commit' }, SPEED);
    assert.equal(s.value, 50);
  });

  test('a negative can be typed at all', () => {
    let s: FieldState = { draft: null, value: 0 };
    s = nextField(s, { t: 'type', text: '-' }, PAN);
    assert.equal(fieldText(s, f(2)), '-', 'a lone minus is on its way to a number');
    s = typeAll(s, '-0.75', PAN);
    s = nextField(s, { t: 'commit' }, PAN);
    assert.equal(s.value, -0.75);
  });

  test('commit clamps, because the slider beside it cannot show 900', () => {
    let s: FieldState = { draft: null, value: 1 };
    s = typeAll(s, '900', ZOOM);
    s = nextField(s, { t: 'commit' }, ZOOM);
    assert.equal(s.value, 4);
  });

  test('a draft that says nothing numeric leaves the value alone', () => {
    for (const junk of ['', '   ', 'abc', '12x', '-', '.']) {
      let s: FieldState = { draft: null, value: 2 };
      s = nextField(s, { t: 'type', text: junk }, ZOOM);
      s = nextField(s, { t: 'commit' }, ZOOM);
      assert.equal(s.value, 2, `"${junk}" should not have become a value`);
      assert.equal(s.draft, null, 'and the field goes back to showing the value');
    }
  });

  test('escape throws the draft away', () => {
    let s: FieldState = { draft: null, value: 2 };
    s = typeAll(s, '3.5', ZOOM);
    s = nextField(s, { t: 'cancel' }, ZOOM);
    assert.equal(s.value, 2);
    assert.equal(fieldText(s, f(3)), '2.000');
  });

  test('a value arriving from the slider ends the draft', () => {
    let s: FieldState = { draft: null, value: 1 };
    s = typeAll(s, '2.2', ZOOM);
    s = nextField(s, { t: 'value', value: 1.5 }, ZOOM);
    assert.equal(s.draft, null);
    assert.equal(fieldText(s, f(3)), '1.500');
  });

  test('committing an untouched field changes nothing', () => {
    const s: FieldState = { draft: null, value: 1 };
    assert.equal(nextField(s, { t: 'commit' }, ZOOM), s);
  });
});

// ── the shell's keys ────────────────────────────────────────────────────

describe('shell shortcuts', () => {
  test('undo and redo are bound, not just printed on a tooltip', () => {
    assert.equal(shellShortcut({ key: 'z', metaKey: true }), 'undo');
    assert.equal(shellShortcut({ key: 'z', ctrlKey: true }), 'undo');
    assert.equal(shellShortcut({ key: 'Z', metaKey: true, shiftKey: true }), 'redo');
    assert.equal(shellShortcut({ key: 'z', ctrlKey: true, shiftKey: true }), 'redo');
  });

  test('the palette chord still works', () => {
    assert.equal(shellShortcut({ key: 'k', metaKey: true }), 'palette');
    assert.equal(shellShortcut({ key: 'K', ctrlKey: true }), 'palette');
  });

  test('Alt D reaches the workbench on a Mac, where Alt D is not the letter D', () => {
    assert.equal(shellShortcut({ key: '∂', code: 'KeyD', altKey: true }), 'workbench');
    assert.equal(shellShortcut({ key: 'd', code: 'KeyD', altKey: true }), 'workbench');
  });

  test('a bare letter is not a shortcut', () => {
    assert.equal(shellShortcut({ key: 'z' }), null);
    assert.equal(shellShortcut({ key: 'd' }), null);
    assert.equal(shellShortcut({ key: 'k' }), null);
  });

  test('typing into a field keeps its own undo, and only the palette overrides it', () => {
    assert.equal(shellShortcut({ key: 'z', metaKey: true }, true), null);
    assert.equal(shellShortcut({ key: 'z', metaKey: true, shiftKey: true }, true), null);
    assert.equal(shellShortcut({ key: 'd', code: 'KeyD', altKey: true }, true), null);
    assert.equal(shellShortcut({ key: 'k', metaKey: true }, true), 'palette');
  });

  test('isTyping knows a text field from a canvas', () => {
    assert.equal(isTyping({ tagName: 'INPUT' }), true);
    assert.equal(isTyping({ tagName: 'TEXTAREA' }), true);
    assert.equal(isTyping({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(isTyping({ tagName: 'DIV' }), false);
    assert.equal(isTyping(null), false);
    assert.equal(isTyping(undefined), false);
  });

  /**
   * A shortcut printed on a tooltip and bound nowhere is a promise the app
   * breaks every time someone believes it.
   *
   * Two things can keep that promise and the test has to ask both. The shell
   * binds the palette chord itself; everything on a menu is bound by the
   * command registry. Export is the reason this matters: it prints Cmd+E from
   * the toolbar and is bound by the registry, having left the File menu for
   * the button, so a test that only knew about `shellShortcut` would have
   * called a live binding dead.
   */
  test('every shortcut the toolbar advertises resolves to an action', () => {
    /** What each advertised string means as a keystroke. */
    const ADVERTISED: Record<string, Parameters<typeof shellShortcut>[0]> = {
      'Cmd / Ctrl + K': { key: 'k', metaKey: true },
      'Cmd / Ctrl + Z': { key: 'z', metaKey: true },
      'Shift + Cmd / Ctrl + Z': { key: 'z', metaKey: true, shiftKey: true },
      'Cmd / Ctrl + E': { key: 'e', metaKey: true },
      'Cmd / Ctrl + I': { key: 'i', metaKey: true },
      'Shift + Cmd / Ctrl + J': { key: 'j', metaKey: true, shiftKey: true },
      'Alt / Opt + D': { key: '∂', code: 'KeyD', altKey: true },
    };
    const commands = buildCommands(NO_ACTIONS);
    const source = read('components/shell/Toolbar.tsx');
    const printed = [...source.matchAll(/meta="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(printed.length >= 3, 'the toolbar should still be advertising its shortcuts');
    for (const label of printed) {
      const chord = ADVERTISED[label];
      assert.ok(chord, `the toolbar advertises "${label}" and nothing here says what it means`);
      const bound = shellShortcut(chord) !== null
        || commands.some((c) => matchShortcut(chord, c.shortcut));
      assert.ok(bound, `"${label}" is printed on a button and bound to nothing`);
    }
  });

  test('the toolbar builds no button for Assistant or Media Pool, because the tabs do', () => {
    // the props, not the prose: the file explains in a comment why these two
    // are absent, and a search of the whole source finds that explanation
    const src = read('components/shell/Toolbar.tsx');
    for (const label of ['Assistant', 'Media Pool', 'Tools']) {
      assert.equal(
        src.includes(`label="${label}"`),
        false,
        `the toolbar builds a ${label} button again, and the browser column already has one`,
      );
    }
  });

  test('Export is a button, and the command behind it survives to hold the key', () => {
    assert.ok(read('components/shell/Toolbar.tsx').includes('className="cr-export"'));
    const exportCmd = buildCommands(NO_ACTIONS).find((c) => c.id === 'file.export');
    assert.ok(exportCmd, 'without the command there is no Cmd+E');
    assert.ok(exportCmd.shortcut, 'and without a shortcut the command is only the button');
  });
});

// ── the tool rail ───────────────────────────────────────────────────────

/**
 * An Actions bag that does nothing.
 *
 * This file never runs a command, it only asks the registry which chords are
 * claimed. A stub whose methods throw would be the safer default, but every
 * one of these is a function the registry stores and does not call, so
 * no-ops say that more plainly than a throw nobody will ever see.
 */
const NO_ACTIONS: Actions = {
  edit: () => {}, undo: () => {}, redo: () => {}, seek: () => {},
  job: async () => undefined,
  newProject: () => {}, open: () => {},
  save: async () => {}, saveAs: async () => {},
  importMedia: () => {}, exportVideo: () => {},
  toggleSnapping: () => {}, toggleLinked: () => {},
  bladeAtPlayhead: () => {}, rippleDelete: () => {},
  addTrack: () => {}, zoomFit: () => {}, zoomIn: () => {}, zoomOut: () => {},
  openWorkbench: () => {}, openJobs: () => {}, selectAll: () => {}, showShortcuts: () => {},
  notify: () => {},
};

const byCard = (tools: Tool[], cardId: string): Tool => {
  const hit = tools.find((t) => t.cardId === cardId);
  assert.ok(hit, `no tool built from the ${cardId} card`);
  return hit;
};

describe('tool rail preconditions', () => {
  test('the playhead on a clip\'s first frame is not a place to blade', () => {
    const doc = demoProject();
    // the second clip on V1, so there is something either side of the cut
    const second = findClip(doc, 'clp_lake_next_to_mountains') as PlacedItem;
    assert.ok(second, 'the demo project should still have this clip');
    const start = second.range.start;

    assert.equal(
      toolContext(doc, start, null).splittableAtPlayhead,
      false,
      'blading on the first frame leaves a zero-length piece behind',
    );
    assert.equal(toolContext(doc, F(start + 1), null).splittableAtPlayhead, true);
    assert.equal(
      toolContext(doc, F(start - 1), null).splittableAtPlayhead,
      true,
      'one frame earlier is inside the clip before it, which is splittable',
    );
  });

  test('past the end of the edit there is nothing to blade', () => {
    const doc = demoProject();
    const after = F(timelineDuration(doc) + 10);
    assert.equal(toolContext(doc, after, null).splittableAtPlayhead, false);
  });

  test('the burn tool says why it cannot run, on a timeline it cannot run on', () => {
    const doc = demoProject();
    const burn = byCard(buildTools(), 'subtitle-burn');
    assert.equal(toolWhy(burn, toolContext(doc, F(0), null)), null, 'the demo has dialogue to transcribe');

    // strip the sound and the tool has nothing to hear
    const ops: EditOp[] = [];
    for (const track of doc.tracks) {
      if (track.kind !== 'audio') continue;
      for (const item of track.items) if (item.kind === 'clip') ops.push({ op: 'remove_clip', clipId: item.id });
    }
    assert.ok(ops.length, 'the demo project should still have audio to remove');
    const silent = applyEdits(doc, ops).timeline;
    assert.equal(toolWhy(burn, toolContext(silent, F(0), null)), 'no audio track to transcribe');
  });

  /**
   * The archived cards left their PRESENTATION entries behind with them, and
   * the fixtures still carry their ids. So a fixture card with no entry is
   * exactly the case `improvise()` is for, and what it must NOT do is invent
   * a precondition: a tool that refuses to run for a reason nobody wrote is
   * worse than one that always offers to.
   */
  test('a card with no presentation entry gets a tool, and no invented precondition', () => {
    const doc = demoProject();
    const improvised = byCard(buildTools(), 'timeline-blade');
    assert.equal(improvised.requires, undefined, 'improvise() must not make up a rule');
    assert.equal(toolWhy(improvised, toolContext(doc, F(0), null)), null);
    assert.equal(improvised.name, 'Timeline blade', 'the name is made from the id');
  });

  test('the counts come off the document, and follow it when it is edited', () => {
    const doc = demoProject();
    const before = trackFacts(doc);
    assert.ok(before.videoClipCount > 1);
    assert.equal(before.hasVideo, true);
    assert.equal(before.hasAudio, true);

    // apply a real batch and ask the document that comes out, rather than
    // trusting the shape of the ops
    const ops: EditOp[] = [{ op: 'remove_clip', clipId: 'clp_lake_next_to_mountains' }];
    const { timeline: after } = applyEdits(doc, ops);
    assert.equal(trackFacts(after).videoClipCount, before.videoClipCount - 1);

  });

  test('a timeline stripped to one video clip counts as one', () => {
    let doc = demoProject();
    const ops: EditOp[] = [];
    for (const track of doc.tracks.filter((t) => t.kind === 'video')) {
      for (const item of track.items) {
        if (item.kind === 'clip' && item.id !== 'clp_redrock_talent_3') {
          ops.push({ op: 'remove_clip', clipId: item.id });
        }
      }
    }
    doc = applyEdits(doc, ops).timeline;
    assert.equal(trackFacts(doc).videoClipCount, 1, 'the batch really did remove them from the document');
  });
});

describe('what a click costs', () => {
  test('rung 1 runs locally and nothing dearer does', () => {
    const tools = buildTools();
    for (const id of ['timeline-blade', 'timeline-ripple', 'timeline-punch']) {
      const tool = byCard(tools, id);
      assert.equal(toolRung(tool), 1, `${id} should be a rung-1 document patch`);
      assert.equal(runsLocally(tool), true, `${id} must run on the click, with no run card`);
    }
    const levels = byCard(tools, 'volume-adjust');
    assert.equal(toolRung(levels), 2);
    assert.equal(runsLocally(levels), false, 'rung 2 is an operation and gets a confirmation');

    for (const id of ['subtitle-burn', 'auto-broll-weave', 'colour-match']) {
      assert.equal(runsLocally(byCard(tools, id)), false, `${id} spends GPU time`);
    }
  });

  test('every tool on the rail is built from a card', () => {
    for (const tool of buildTools()) {
      assert.ok(tool.cardId, `${tool.name} has no card`);
      assert.ok(toolRung(tool) >= 1, `${tool.name} has no rung`);
    }
  });

  test('the rail is the registry as it is now, not as it was at import', () => {
    // the workbench writes a card and the rail has to show it: this is the
    // whole reason buildTools is a function rather than a module constant
    const before = buildTools();
    try {
      putCard('bench-made', [
        '---',
        'id: bench-made',
        'kind: pipeline',
        'rung: 3',
        'cost: ~40s · GPU',
        'match: bench made',
        '---',
        '',
        '## What it does',
        'Something the workbench built.',
        '',
      ].join('\n'));

      const after = buildTools();
      assert.equal(after.length, before.length + 1);
      const fresh = byCard(after, 'bench-made');
      assert.equal(fresh.name, 'Bench made', 'a card with no icon still gets a place on the rail');
      assert.equal(runsLocally(fresh), false, 'rung 3 spends GPU time and gets a run card');
    } finally {
      // back to the fixture corpus, not to the product's, which may be empty
      useFixtures();
    }
    assert.equal(buildTools().length, before.length, 'and a revert takes it away again');
  });
});

describe('searching the rail with the words the router knows', () => {
  test('a card that claims "cutaway" wins it, and says the claim is a match', () => {
    const hits = searchTools(buildTools(), 'cutaway');
    const broll = hits.find((h) => h.tool.cardId === 'auto-broll-weave');
    assert.ok(broll, 'the b-roll card claims "cutaway" and must be found by it');
    assert.equal(broll.phrase, 'cutaway');
    assert.equal(broll.from, 'match', 'a match phrase beats an example');
  });

  test('a word the router knows finds the tool, not just the tool\'s name', () => {
    const hits = searchTools(buildTools(), 'louder');
    const levels = hits.find((h) => h.tool.cardId === 'volume-adjust');
    assert.ok(levels, '"louder" is nowhere in the name "Level the audio"');
    assert.equal(levels.phrase, 'louder');
    assert.equal(levels.from, 'match');
  });

  test('a phrase only an example uses is credited to the example', () => {
    const hits = searchTools(buildTools(), 'this drags');
    const tighten = hits.find((h) => h.tool.cardId === 'tighten-cut');
    assert.ok(tighten);
    assert.equal(tighten.phrase, 'this drags');
    assert.equal(tighten.from, 'example', 'the match list did not claim it, an example did');
  });

  test('an empty query is the whole rail, unranked', () => {
    const tools = buildTools();
    const hits = searchTools(tools, '   ');
    assert.equal(hits.length, tools.length);
    assert.ok(hits.every((h) => h.phrase === null && h.from === null));
  });

  test('a word nobody claims finds nobody', () => {
    assert.deepEqual(searchTools(buildTools(), 'zzzznothing'), []);
  });
});

// ── tokens ──────────────────────────────────────────────────────────────

describe('SSR token fallbacks', () => {
  test('every fallback still matches app/globals.css', () => {
    const css = read('app/globals.css');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('@theme inline'));
    assert.ok(root.length > 200, 'the :root block moved, so this test is reading nothing');

    const declared = new Map<string, string>();
    for (const m of root.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
      declared.set(m[1], m[2].trim());
    }
    assert.ok(declared.size > 20, `only parsed ${declared.size} tokens out of :root`);

    const drift: string[] = [];
    for (const [name, value] of Object.entries(FALLBACKS)) {
      const real = declared.get(name);
      if (real === undefined) drift.push(`${name} is not in app/globals.css at all`);
      else if (real !== value) drift.push(`${name}: fallback ${value}, css ${real}`);
    }
    assert.deepEqual(drift, [], `the SSR fallback table has drifted:\n${drift.join('\n')}`);
  });
});

// ── what the source has to keep ─────────────────────────────────────────

describe('structure the panels have to keep', () => {
  test('the viewer runs no clock of its own', () => {
    const src = read('components/viewer/Viewer.tsx');
    assert.ok(
      src.includes('usePlayheadController'),
      'the viewer drives the PlayheadController, it does not roll a transport',
    );
    assert.equal(
      /performance\.now\(\)/.test(src),
      false,
      'a second clock in the viewer is a second answer to where the playhead is',
    );
    assert.equal(
      /\(now - last\)|\(ts - last\)/.test(src),
      false,
      'accumulating frames from a timestamp delta is a playback loop, wherever it is written',
    );
    assert.ok(
      /controller\?: PlayheadController/.test(src),
      'the viewer has to accept the timeline\'s controller to share its playhead',
    );
  });

  test('the viewer itself takes the keys its tooltips advertise', () => {
    const src = read('components/viewer/Viewer.tsx');
    const at = src.indexOf('className="cr-viewer"');
    assert.ok(at > 0, 'the viewer root moved and this test is reading the wrong element');
    // a fixed window rather than up to the first '>': an arrow function in an
    // attribute contains one
    const attrs = src.slice(at, at + 400);
    assert.ok(
      /tabIndex=\{0\}/.test(attrs),
      'a container that cannot hold focus never sees a key: Space, the arrows, Home and End '
      + 'are all advertised on the transport and all dead without this',
    );
    assert.ok(/onKeyDown=/.test(attrs), 'and it has to listen for them');
  });

  test('the shell does not snapshot the tool list at mount', () => {
    const src = read('components/shell/Shell.tsx');
    assert.equal(
      /useMemo\(\(\) => buildTools\(\), \[\]\)/.test(src),
      false,
      'an empty dependency list is the staleness buildTools() is a function to avoid',
    );
    assert.ok(/buildTools\(\)/.test(src), 'the shell still builds the rail from the cards');
  });

  test('the shell does not speak over its host', () => {
    const src = read('components/shell/Shell.tsx');
    assert.ok(
      /\{onNotify \? null : \(/.test(src),
      'the shell toast and the host toast sit at the same place: only one of them renders',
    );
    assert.ok(
      /if \(onNotify\) \{ onNotify\(text\); return; \}/.test(src),
      'say() hands the message to the host INSTEAD of showing it, not as well',
    );
  });

  test('the toolbar invents no project resolution', () => {
    const src = read('components/shell/Toolbar.tsx');
    assert.equal(
      /resolution = ['"`]/.test(src),
      false,
      'a hard-coded default is a number every project displays and no caller can correct',
    );
  });

  test('the shell sizes the timeline from the tracks, not from the window', () => {
    const src = read('components/shell/Shell.tsx');
    assert.ok(
      /fitTimelineHeight\(timeline\.tracks, vh\)/.test(src),
      'the panel is the sum of the lanes in it, which is the only reason adding a track grows it',
    );
    assert.equal(
      /Math\.round\(vh \* 0\.4/.test(src),
      false,
      'a fraction of the window is the empty ground this replaced',
    );
    assert.ok(
      /onReset=\{\(\) => \{ setTimelineDrag\(null\)/.test(src),
      'reset goes back to following the tracks, not to a pinned number',
    );
  });
});

// ── how tall the timeline panel is ──────────────────────────────────────
// It opened at 42% of the window whatever was in it, so a four track cut sat
// above a hand's width of empty ground and the viewer had lost that space to
// hold it.

describe('the timeline is as tall as its tracks', () => {
  const tracksOf = (kinds: TrackKind[]): Track[] => kinds.map((kind, i) => ({
    id: `trk_${i}` as Track['id'], kind, name: `${kind} ${i}`, items: [],
    locked: false, muted: false, solo: false, enabled: true, autoSelect: true,
  }));

  /** Toolbar, its hairline, the ruler, and the ground under the last lane. */
  const CHROME = TIMELINE_TOOLBAR_HEIGHT + 1 + RULER_HEIGHT + TIMELINE_TAIL;
  const TALL = 2000; // so nothing below is measuring the ceiling by accident

  test('it is the chrome plus the lanes that exist', () => {
    const kinds: TrackKind[] = ['video', 'subtitle', 'video', 'audio'];
    const lanes = kinds.reduce((h, k) => h + TRACK_HEIGHT[k], 0);
    assert.equal(fitTimelineHeight(tracksOf(kinds), TALL), CHROME + lanes);
  });

  test('a video track adds 68 and an audio track adds 46', () => {
    const base = fitTimelineHeight(tracksOf(['video']), TALL);
    assert.equal(fitTimelineHeight(tracksOf(['video', 'video']), TALL) - base, TRACK_HEIGHT.video);
    assert.equal(fitTimelineHeight(tracksOf(['video', 'audio']), TALL) - base, TRACK_HEIGHT.audio);
    assert.equal(
      fitTimelineHeight(tracksOf(['video', 'subtitle']), TALL) - base, TRACK_HEIGHT.subtitle,
      'a subtitle lane is shorter than either, and the panel has to say so',
    );
  });

  test('it never grows past what the viewer needs', () => {
    const many = tracksOf(Array<TrackKind>(24).fill('video'));
    const vh = 900;
    assert.ok(fitTimelineHeight(many, TALL) > vh, 'the fixture is big enough to be capped');
    assert.equal(fitTimelineHeight(many, vh), vh - VIEWER_MIN_HEIGHT);
  });

  test('and never shrinks below being a timeline', () => {
    assert.equal(fitTimelineHeight([], TALL), TIMELINE_MIN_HEIGHT);
    assert.equal(
      fitTimelineHeight(tracksOf(['video', 'video', 'video']), 200), TIMELINE_MIN_HEIGHT,
      'a window too short for both still leaves the timeline usable',
    );
  });
});
