/**
 * The destinations the export dialog offers.
 *
 * A preset is a claim about what a file has to be to be accepted somewhere,
 * and the way it goes wrong is quiet: an odd height that h264 refuses, a
 * bitrate the Advanced menu cannot show, a card that says "vertical" and is
 * 1920 wide. None of those look wrong in the table.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TARGETS, QUALITIES, targetFor, videoBitrateFor, aspectLabel, fitAdvice,
} from '../lib/export/targets.ts';
import { getEncoderLimits } from '../lib/export/limits.ts';

/** The rates the Advanced menu lists, which is the other half of every pair. */
const OFFERED = ['2M', '5M', '8M', '12M', '20M', '40M'];

describe('every destination is something the encoder will actually write', () => {
  const limits = getEncoderLimits();

  test('there are destinations, so the rest of this file checked something', () => {
    assert.ok(TARGETS.length >= 4, `${TARGETS.length} is not a menu`);
  });

  test('ids are unique, or one card cannot be told from another', () => {
    assert.equal(new Set(TARGETS.map((t) => t.id)).size, TARGETS.length);
  });

  test('every frame is inside the encoder limits and even on both sides', () => {
    for (const t of TARGETS) {
      assert.ok(t.width >= limits.minWidth && t.width <= limits.maxWidth, `${t.id} width`);
      assert.ok(t.height >= limits.minHeight && t.height <= limits.maxHeight, `${t.id} height`);
      // yuv420p has half as many chroma samples as luma, so an odd dimension
      // leaves the last row or column of one of them undefined
      assert.equal(t.width % 2, 0, `${t.id} width is odd`);
      assert.equal(t.height % 2, 0, `${t.id} height is odd`);
    }
  });

  test('the shape on the card is the shape of the numbers under it', () => {
    for (const t of TARGETS) {
      const real = t.width > t.height ? 'landscape' : t.width < t.height ? 'vertical' : 'square';
      assert.equal(t.shape, real, `${t.id} says ${t.shape} and is ${real}`);
    }
  });

  test('the point of the exercise: a phone shape and a television shape are both here', () => {
    assert.ok(TARGETS.some((t) => t.shape === 'vertical'), 'nothing to export for a reel');
    assert.ok(TARGETS.some((t) => t.shape === 'landscape'), 'nothing to export for YouTube');
  });

  test('a card can be found again from the size it set', () => {
    for (const t of TARGETS) {
      // the first card with those numbers wins, and three of them share a frame
      const found = targetFor(t.width, t.height);
      assert.ok(found, `${t.id} cannot be recognised from ${t.width}x${t.height}`);
      assert.equal(found.width, t.width);
      assert.equal(found.height, t.height);
    }
    assert.equal(targetFor(1234, 5678), null, 'a typed-in size is not a card');
  });
});

describe('quality is a bitrate the rest of the dialog can also show', () => {
  test('every quality at every destination is a rate the menu offers', () => {
    let checked = 0;
    for (const t of TARGETS) {
      for (const q of QUALITIES) {
        const rate = videoBitrateFor(t.height, q.id);
        assert.ok(OFFERED.includes(rate), `${t.id} at ${q.id} is ${rate}, which Advanced cannot display`);
        checked += 1;
      }
    }
    assert.ok(checked > 0, 'no pairs, so nothing above was checked');
  });

  test('best is never below standard, and standard never below smallest', () => {
    const num = (r: string) => Number(r.slice(0, -1)) * (r.endsWith('M') ? 1000 : 1);
    for (const h of [720, 1080, 1350, 1920, 2160]) {
      const high = num(videoBitrateFor(h, 'high'));
      const std = num(videoBitrateFor(h, 'standard'));
      const small = num(videoBitrateFor(h, 'small'));
      assert.ok(high > std && std > small, `${h}: ${high}/${std}/${small}`);
    }
  });

  test('a taller frame gets more bits at the same quality', () => {
    const num = (r: string) => Number(r.slice(0, -1));
    assert.ok(num(videoBitrateFor(2160, 'standard')) > num(videoBitrateFor(1080, 'standard')));
  });
});

describe('what the fit will do, said before it is done', () => {
  const REEL = { width: 1080, height: 1920 };
  const HD = { width: 1920, height: 1080 };

  test('16:9 is 16:9 and 9:16 is 9:16', () => {
    assert.equal(aspectLabel(1920, 1080), '16:9');
    assert.equal(aspectLabel(1080, 1920), '9:16');
    assert.equal(aspectLabel(1080, 1080), '1:1');
  });

  test('matching shapes get no advice, because both fits do the same thing', () => {
    assert.equal(fitAdvice({ width: 1920, height: 1080 }, HD), null);
    assert.equal(fitAdvice({ width: 3840, height: 2160 }, HD), null, 'the shape, not the size');
  });

  test('footage with no size reported says nothing rather than something wrong', () => {
    assert.equal(fitAdvice(null, REEL), null);
    assert.equal(fitAdvice({ width: 1920 }, REEL), null);
  });

  test('wide footage in a tall frame loses its sides, or gains bars above and below', () => {
    const a = fitAdvice({ width: 1920, height: 1080 }, REEL);
    assert.ok(a);
    assert.equal(a.source, '16:9');
    assert.equal(a.target, '9:16');
    assert.match(a.contain, /above and below/);
    assert.match(a.cover, /left and right/);
  });

  test('tall footage in a wide frame is the same sentence the other way round', () => {
    const a = fitAdvice({ width: 1080, height: 1920 }, HD);
    assert.ok(a);
    assert.match(a.contain, /either side/);
    assert.match(a.cover, /top and bottom/);
  });
});

/**
 * The dialog is JSX, so `npm test` cannot import it and nothing above would
 * notice if it stopped using any of this.
 *
 * That is the shape of defect this repo has written down twice: a mechanism
 * exported, tested against itself, and called by nothing, while a document
 * claimed it was connected. So the connection is asserted by reading the
 * module that is supposed to make it, which is the cheapest thing that can
 * fail when it stops being true.
 */
describe('the project creation and export dialogs are built out of this table', () => {
  const newProjectDialog = readFileSync(
    new URL('../components/shell/NewProjectDialog.tsx', import.meta.url), 'utf8',
  );
  const dialog = readFileSync(
    new URL('../components/export/ExportDialog.tsx', import.meta.url), 'utf8',
  );

  test('there are dialogs to read, or the rest of this passes over nothing', () => {
    assert.ok(newProjectDialog.length > 1000, 'NewProjectDialog.tsx is not where this expects it');
    assert.ok(dialog.length > 2000, 'ExportDialog.tsx is not where this expects it');
  });

  test('it imports the destinations rather than listing its own', () => {
    assert.match(newProjectDialog, /from '@\/lib\/export\/targets\.ts'/);
    assert.match(newProjectDialog, /TARGETS\.map\(/, 'the cards are drawn from the table');
    assert.match(dialog, /from '@\/lib\/export\/targets\.ts'/);
  });

  test('the settings it opens on are derived, not typed in again', () => {
    // a hardcoded 1920 here and a changed TARGETS[0] there is a dialog that
    // opens on a destination it does not show as chosen
    assert.match(dialog, /const OPENS_ON = TARGETS\[0\]/);
    assert.match(dialog, /width: OPENS_ON\.width/);
    assert.match(dialog, /height: OPENS_ON\.height/);
    assert.match(dialog, /videoBitrate: videoBitrateFor\(OPENS_ON\.height, 'standard'\)/);
  });

  test('the fit the user picked is the fit the compiler is given', () => {
    // `toDelivery` is the only thing that crosses from the dialog into the
    // render, so a fit that is chosen and not passed is a control that does
    // nothing while looking like it works
    const at = dialog.indexOf('export const toDelivery');
    assert.ok(at > 0, 'toDelivery is gone');
    assert.match(dialog.slice(at, at + 500), /fit: s\.fit \?\? 'contain'/);
  });
});
