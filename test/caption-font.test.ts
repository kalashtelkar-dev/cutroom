/**
 * The font a burn needs, and the font that is actually on disk.
 *
 * Two halves, and the second is the one that matters. A wrong family name
 * here fails nowhere: the mux succeeds, the burn succeeds, the run succeeds,
 * and the delivered file has a row of empty boxes where the words were.
 * Nothing in a graph, a schema or a status code can see it. So the test opens
 * the font file, reads the name its own name table carries, and fails if that
 * and `BUNDLED` ever disagree.
 *
 * It reads the cmap too. `script: 'Devanagari'` is a claim about coverage,
 * and a file swapped for one that does not cover it would otherwise pass
 * every check here while rendering the same boxes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { BUNDLED, FONT_DIR, fontForCaptions } from '../lib/subtitles/fonts.ts';

const HINDI = 'आप नहीं समझोगी मम्मी, कितना मसाला बच जाता है इनमें।';

describe('which font a set of captions needs', () => {
  test('Latin needs nothing: the render server draws it already', () => {
    const need = fontForCaptions('Hello there, 50% of it [ok]');
    assert.equal(need.font, null);
    assert.deepEqual(need.missing, []);
  });

  test('the scripts the server was measured to draw need nothing', () => {
    // burned one line per script over black and looked at the pixels; these
    // came back as words and the rest came back as boxes
    for (const sample of ['Ελληνικά', 'Русский', 'العربية', 'עברית', 'Հայերեն', 'ქართული']) {
      assert.deepEqual(fontForCaptions(sample), { font: null, missing: [], crowdedOut: [] }, sample);
    }
  });

  test('Hindi asks for the Devanagari font, by the name libass matches on', () => {
    const need = fontForCaptions(HINDI);
    assert.equal(need.font?.family, 'Noto Sans Devanagari');
    assert.equal(need.font?.file, 'NotoSansDevanagari.ttf');
    assert.deepEqual(need.missing, []);
  });

  test('punctuation and digits mixed in do not change the answer', () => {
    const need = fontForCaptions(`1. ${HINDI} (50%)`);
    assert.equal(need.font?.script, 'Devanagari');
    assert.deepEqual(need.missing, []);
  });

  test('a script with no bundled font is named, not passed over in silence', () => {
    // Tibetan is in the table that names scripts and not in the one that
    // ships fonts, which is exactly the case that has to speak up
    const need = fontForCaptions('བོད་སྐད།');
    assert.equal(need.font, null);
    assert.deepEqual(need.missing, ['Tibetan']);
  });

  test('one FontName means the other script has to be reported', () => {
    const need = fontForCaptions(`${HINDI}\n这是中文字幕`);
    assert.equal(need.font?.script, 'Devanagari');
    // we HAVE a Chinese font and cannot reach it: that is a different
    // sentence from not having one, and it is not `missing`
    assert.deepEqual(need.missing, []);
    assert.deepEqual(need.crowdedOut, ['Chinese']);
  });

  test('the font goes to the commonest script we have one for, not the first', () => {
    // Tibetan outnumbers Devanagari here and has no font: the attachment
    // should still be the one that can do something for somebody
    const need = fontForCaptions(`हिन्दी\n${'བོད་སྐད།'.repeat(5)}`);
    assert.equal(need.font?.script, 'Devanagari');
    assert.deepEqual(need.missing, ['Tibetan']);
  });

  /**
   * The hole this closes.
   *
   * Deciding from a list of scripts we thought of would ship boxes in silence
   * for the first script nobody thought of. What decides is what the server
   * was measured to draw, so an unknown script is counted whether or not
   * anything here can name it.
   */
  test('a script nothing here can name is still counted, by its characters', () => {
    const need = fontForCaptions('ᏣᎳᎩ'); // Cherokee, in no table in that file
    assert.equal(need.font, null);
    // one entry for the lot of them, not one per character
    assert.equal(need.missing.length, 1);
    assert.match(need.missing[0], /U\+13E3/);
  });

  /**
   * Measured, both halves of it. A row of these was burned over black and
   * looked at: the three on the left came back as boxes and the three on the
   * right came back as themselves, which is the Emoji_Presentation line and
   * not a block range.
   */
  test('emoji are boxes, and the dingbats that are not emoji are not', () => {
    for (const ch of ['✅', '❌', '🔥']) {
      const need = fontForCaptions(`a tick ${ch} here`);
      assert.equal(need.missing.length, 1, ch);
      assert.match(need.missing[0], /characters like/);
    }
    for (const ch of ['☺', '★', '✓', '→', '±']) {
      assert.deepEqual(fontForCaptions(`a mark ${ch} here`), { font: null, missing: [], crowdedOut: [] }, ch);
    }
  });

  test('emoji do not rob the captions of the font the words need', () => {
    const need = fontForCaptions(`${HINDI} 🔥`);
    assert.equal(need.font?.script, 'Devanagari');
    assert.equal(need.missing.length, 1, 'nothing bundles emoji, so it is missing and not crowded out');
    assert.deepEqual(need.crowdedOut, []);
  });

  /**
   * Measured from the cmaps: SC has simplified, traditional, the Japan-only
   * kanji and kana, and no Hangul. JP has no simplified. KR has neither
   * those nor the Japan-only kanji, and is the only one with Hangul.
   */
  describe('CJK is decided by the company the characters keep', () => {
    test('kana mean the kanji beside them are Japanese, whatever the count', () => {
      // five Han against three kana: a count alone hands this to the Chinese
      // font and draws a Japanese caption in Chinese letterforms
      const need = fontForCaptions('日本語の字幕です');
      assert.equal(need.font?.family, 'Noto Sans JP');
      assert.deepEqual(need.missing, []);
    });

    test('Han on its own is Chinese', () => {
      const need = fontForCaptions('这是中文字幕');
      assert.equal(need.font?.family, 'Noto Sans SC');
      assert.deepEqual(need.missing, []);
    });

    test('Hangul take the lot, because Noto Sans KR covers Han and kana too', () => {
      const need = fontForCaptions('한국어 자막입니다 日本 の');
      assert.equal(need.font?.family, 'Noto Sans KR');
      assert.deepEqual(need.missing, []);
    });

    test('folding CJK together does not swallow a script from elsewhere', () => {
      const need = fontForCaptions(`日本語です\n${HINDI}`);
      assert.equal(need.font?.script, 'Devanagari');
      assert.deepEqual(need.missing, []);
      assert.deepEqual(need.crowdedOut, ['Japanese']);
    });
  });

  test('every bundled script is one this asks for by name', () => {
    // a font nothing can ever select is a 600K file that does nothing
    for (const font of BUNDLED) {
      const sample = SAMPLES[font.script];
      assert.ok(sample, `no sample for ${font.script}`);
      const need = fontForCaptions(sample);
      assert.equal(need.font?.family, font.family, `${font.script} selected ${need.font?.family}`);
    }
  });

  test('no captions, nothing to ask for', () => {
    assert.deepEqual(fontForCaptions(''), { font: null, missing: [], crowdedOut: [] });
  });
});

// ── the font on disk is the font that was promised ──────────────────────

/**
 * A word in each bundled font's script.
 *
 * Every bundled font must have one, so adding a font without one fails here
 * rather than quietly skipping the coverage check: a check that walks an
 * empty list is a check that reports success forever.
 */
const SAMPLES: Record<string, string> = {
  Devanagari: 'हिन्दी मसाला',
  Bengali: 'বাংলা ভাষা',
  Gurmukhi: 'ਪੰਜਾਬੀ ਬੋਲੀ',
  Gujarati: 'ગુજરાતી ભાષા',
  Odia: 'ଓଡ଼ିଆ ଭାଷା',
  Tamil: 'தமிழ் மொழி',
  Telugu: 'తెలుగు భాష',
  Kannada: 'ಕನ್ನಡ ಭಾಷೆ',
  Malayalam: 'മലയാളം ഭാഷ',
  Sinhala: 'සිංහල භාෂාව',
  Thai: 'ภาษาไทย',
  Lao: 'ພາສາລາວ',
  Khmer: 'ភាសាខ្មែរ',
  Myanmar: 'မြန်မာဘာသာ',
  Ethiopic: 'አማርኛ ቋንቋ',
  Chinese: '这是中文字幕',
  Japanese: '日本語の字幕です',
  Korean: '한국어 자막입니다',
};

/** The sfnt table directory: tag -> the bytes of that table. */
function tables(font: Buffer): Map<string, Buffer> {
  const count = font.readUInt16BE(4);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = font.toString('ascii', at, at + 4);
    const offset = font.readUInt32BE(at + 8);
    const length = font.readUInt32BE(at + 12);
    out.set(tag, font.subarray(offset, offset + length));
  }
  return out;
}

/**
 * Every family name the font declares.
 *
 * Name id 1 is the family and 16 is the typographic family, which a variable
 * font uses when its id 1 names one instance. Both are collected because
 * which one a matcher reads is the matcher's business, and the string we
 * claim has to be one the font actually carries.
 */
function familyNames(name: Buffer): string[] {
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    const platform = name.readUInt16BE(at);
    const nameId = name.readUInt16BE(at + 6);
    if (nameId !== 1 && nameId !== 16) continue;
    const length = name.readUInt16BE(at + 8);
    const offset = name.readUInt16BE(at + 10);
    const raw = name.subarray(strings + offset, strings + offset + length);
    // platform 1 is Macintosh and single byte; 0 and 3 are UTF-16BE, which
    // node reads by swapping the pairs into the little endian it does have
    if (platform === 1) out.push(raw.toString('latin1'));
    else if (raw.length % 2 === 0) out.push(Buffer.from(raw).swap16().toString('utf16le'));
  }
  return out;
}

/** Does the cmap map this codepoint to a glyph? Formats 4 and 12 only. */
function covers(cmap: Buffer, code: number): boolean {
  const count = cmap.readUInt16BE(2);
  for (let i = 0; i < count; i++) {
    const at = 4 + i * 8;
    const platform = cmap.readUInt16BE(at);
    const encoding = cmap.readUInt16BE(at + 2);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;

    const sub = cmap.subarray(cmap.readUInt32BE(at + 4));
    const format = sub.readUInt16BE(0);

    if (format === 4) {
      const segs = sub.readUInt16BE(6) / 2;
      for (let s = 0; s < segs; s++) {
        const end = sub.readUInt16BE(14 + s * 2);
        const start = sub.readUInt16BE(16 + segs * 2 + s * 2);
        if (code < start || code > end) continue;
        const delta = sub.readInt16BE(16 + segs * 4 + s * 2);
        const rangeAt = 16 + segs * 6 + s * 2;
        const range = sub.readUInt16BE(rangeAt);
        if (range === 0) return ((code + delta) & 0xffff) !== 0;
        const glyphAt = rangeAt + range + (code - start) * 2;
        if (glyphAt + 1 >= sub.length) return false;
        return sub.readUInt16BE(glyphAt) !== 0;
      }
    } else if (format === 12) {
      const groups = sub.readUInt32BE(12);
      for (let g = 0; g < groups; g++) {
        const at2 = 16 + g * 12;
        if (code >= sub.readUInt32BE(at2) && code <= sub.readUInt32BE(at2 + 4)) return true;
      }
    }
  }
  return false;
}

describe('the bundled fonts are what the registry says they are', () => {
  test('there is at least one, so none of this is a walk over nothing', () => {
    assert.ok(BUNDLED.length > 0);
  });

  for (const font of BUNDLED) {
    describe(`${font.file}`, () => {
      const path = `${FONT_DIR}/${font.file}`;

      test('the file is there', () => {
        assert.ok(existsSync(path), `${path} is missing, and a missing font is a caption full of boxes`);
      });

      test('its own name table spells the family exactly as we claim it', () => {
        const t = tables(readFileSync(path));
        const name = t.get('name');
        assert.ok(name, 'no name table, so nothing can match this font by family');
        const names = familyNames(name);
        assert.ok(
          names.includes(font.family),
          `fonts.ts claims "${font.family}" and the file says ${JSON.stringify(names)}. `
          + 'libass matches on this string and answers a mismatch with boxes, not an error.',
        );
      });

      /**
       * Latin, in every one of them.
       *
       * `force_style` names one font for the whole cue, so the font that
       * draws the Hindi also draws the English beside it. A font with no
       * Latin would turn "Maggi मसाला" into half a caption, which is a worse
       * bug than the one this is all here to fix.
       */
      test('it covers Latin too, because the style names it for the whole cue', () => {
        const cmap = tables(readFileSync(path)).get('cmap');
        assert.ok(cmap, 'no cmap table');
        for (const ch of 'ABCabc0129 .,?!') {
          assert.ok(covers(cmap, ch.codePointAt(0) as number), `no glyph for "${ch}"`);
        }
      });

      /**
       * At the weight a subtitle is read at.
       *
       * A variable font renders at its default instance, and the CJK
       * variable fonts default to wght 100. That is not boxes, so nothing
       * else here would have caught it: it is a caption in hairline.
       */
      test('a variable font defaults to a weight worth reading', () => {
        const fvar = tables(readFileSync(path)).get('fvar');
        if (!fvar) return; // static: it is whatever weight it was built at
        const axes = fvar.readUInt16BE(8);
        const size = fvar.readUInt16BE(10);
        const at0 = fvar.readUInt16BE(4);
        for (let i = 0; i < axes; i++) {
          const at = at0 + i * size;
          if (fvar.toString('ascii', at, at + 4) !== 'wght') continue;
          const def = fvar.readInt32BE(at + 8) / 65536;
          assert.ok(def >= 350 && def <= 500, `wght defaults to ${def}, so every caption draws at that weight`);
        }
      });

      test(`it covers ${font.script}`, () => {
        const sample = SAMPLES[font.script];
        assert.ok(sample, `no sample text for ${font.script}, so nothing here checked its coverage`);
        const cmap = tables(readFileSync(path)).get('cmap');
        assert.ok(cmap, 'no cmap table');
        for (const ch of sample) {
          const code = ch.codePointAt(0) as number;
          if (ch === ' ') continue;
          assert.ok(covers(cmap, code), `no glyph for "${ch}" (U+${code.toString(16).toUpperCase()})`);
        }
      });
    });
  }
});
