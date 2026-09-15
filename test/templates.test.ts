import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RATES } from '../lib/time/frames.ts';
import { emptyTimeline } from '../lib/timeline/document.ts';
import { PROJECT_TEMPLATES, getTemplate, templateTracks } from '../lib/timeline/templates.ts';
import { place } from '../lib/timeline/document.ts';

describe('project templates', () => {
  test('all templates have unique ids and non-empty tracks', () => {
    assert.ok(PROJECT_TEMPLATES.length >= 4, 'at least four templates provided');
    const ids = new Set(PROJECT_TEMPLATES.map((t) => t.id));
    assert.equal(ids.size, PROJECT_TEMPLATES.length, 'all template ids are unique');

    for (const t of PROJECT_TEMPLATES) {
      assert.ok(t.tracks.length > 0, `template ${t.id} has tracks`);
      assert.ok(t.name.length > 0, `template ${t.id} has a name`);
      assert.ok(t.description.length > 0, `template ${t.id} has a description`);
    }
  });

  test('standard template creates V2, V1, and 3 audio tracks', () => {
    const tracks = templateTracks('standard');
    assert.equal(tracks.length, 5);
    assert.deepEqual(tracks.map((t) => t.kind), ['video', 'video', 'audio', 'audio', 'audio']);
    assert.deepEqual(tracks.map((t) => t.name), ['Video 2', 'Video 1', 'Dialogue', 'SFX', 'Music']);
  });

  test('minimal template creates V1 and A1', () => {
    const tracks = templateTracks('minimal');
    assert.equal(tracks.length, 2);
    assert.deepEqual(tracks.map((t) => t.kind), ['video', 'audio']);
  });

  test('social template includes subtitle track', () => {
    const tracks = templateTracks('social');
    assert.ok(tracks.some((t) => t.kind === 'subtitle'), 'social template carries subtitle track');
    assert.ok(tracks.some((t) => t.kind === 'video'), 'social template carries video track');
    assert.ok(tracks.some((t) => t.kind === 'audio'), 'social template carries audio track');
  });

  test('podcast template creates 4 audio tracks', () => {
    const tracks = templateTracks('podcast');
    const audioTracks = tracks.filter((t) => t.kind === 'audio');
    assert.equal(audioTracks.length, 4, 'podcast template has 4 audio tracks');
  });

  test('emptyTimeline constructs clean document with specified template', () => {
    const doc = emptyTimeline('tl_social_1', 'Social Clip', RATES.film, 'social');
    assert.equal(doc.name, 'Social Clip');
    assert.equal(doc.tracks.length, 3);
    assert.equal(doc.tracks[0].kind, 'subtitle');
    assert.deepEqual(place(doc), [], 'empty timeline places zero items');
  });

  test('unknown template id falls back to standard template', () => {
    const fallback = getTemplate('nonexistent');
    assert.equal(fallback.id, 'standard');
  });
});

