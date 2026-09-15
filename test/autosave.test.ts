/**
 * When the project saves itself.
 *
 * Save and Save As went with the File menu, so this is now the only thing
 * standing between an edit and losing it. The rule worth a test is the third
 * one: a conflict has to STOP autosave. The manual save already refused to
 * retry a stale write, because sending a fresh etag is not a retry, it is
 * overwriting whoever moved first. An autosave that retried would do that by
 * itself, every two seconds, and the person whose work it overwrote would
 * never be asked.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AUTOSAVE_MS, shouldAutosave, saveLabel, type SaveStatus } from '../lib/project/autosave.ts';

const STATUSES: SaveStatus[] = ['saved', 'waiting', 'saving', 'failed', 'conflict'];

describe('deciding to autosave', () => {
  test('a changed document is written', () => {
    assert.equal(shouldAutosave({ dirty: true, saving: false, status: 'saved' }), true);
  });

  test('an unchanged one is not, whatever the status says', () => {
    for (const status of STATUSES) {
      assert.equal(shouldAutosave({ dirty: false, saving: false, status }), false, status);
    }
  });

  test('a write in flight is never joined by a second', () => {
    for (const status of STATUSES) {
      assert.equal(shouldAutosave({ dirty: true, saving: true, status }), false, status);
    }
  });

  /**
   * The rule this file exists for.
   *
   * `saveProject` sends the etag of the revision it read, so a refusal means
   * the project moved underneath us. Saving again with a fresh etag would
   * succeed, and succeed by discarding someone else's revision.
   */
  test('a conflict stops it, and stays stopped while the document keeps changing', () => {
    assert.equal(shouldAutosave({ dirty: true, saving: false, status: 'conflict' }), false);
    // the point: more editing does not clear it. Only a person can.
    assert.equal(shouldAutosave({ dirty: true, saving: false, status: 'conflict' }), false);
  });

  /**
   * A failure is not a conflict. Offline, or a 500, means nobody else wrote
   * anything and ours is still the only version: the next edit should try
   * again rather than needing a person to notice.
   */
  test('an ordinary failure does not stop it', () => {
    assert.equal(shouldAutosave({ dirty: true, saving: false, status: 'failed' }), true);
  });

  test('the delay is long enough to be a pause and short enough to be a save', () => {
    assert.ok(AUTOSAVE_MS >= 500 && AUTOSAVE_MS <= 10_000, `${AUTOSAVE_MS}ms`);
  });
});

describe('what it says it is doing', () => {
  test('every status has words, because a blank chip is a broken one', () => {
    for (const status of STATUSES) {
      const label = saveLabel(status);
      assert.ok(label && label.trim().length > 0, status);
    }
  });

  /**
   * Distinct words, not absent words.
   *
   * The first version of this asserted the failing labels did not contain
   * "saved", and "Not saved" fails that while being exactly the right thing
   * to show a person. What actually matters is that the four states a person
   * must tell apart are four different sentences.
   */
  test('the states a person has to tell apart are told apart', () => {
    const shown = (['saved', 'saving', 'failed', 'conflict'] as SaveStatus[]).map(saveLabel);
    assert.equal(new Set(shown).size, shown.length, `${shown.join(' / ')} does not distinguish them`);
  });
});
