/**
 * The font a burn needs, because the render server does not have it.
 *
 * A caption that reads correctly in the viewer can still come out of the
 * render as a row of empty boxes, and the reason is not the SRT: it is that
 * the font libass picked has no glyph for the character. The browser has the
 * whole machine's font book to fall back through. The render container has
 * one font.
 *
 * Which one is measured, not assumed. Burning a line per script over black
 * and reading the pixels back says the server draws Latin, Greek, Cyrillic,
 * Arabic, Hebrew, Armenian and Georgian, and draws boxes for every Indic
 * script, for Thai, for Han, for kana and for Hangul. That is DejaVu Sans,
 * and it is the whole font book of that machine.
 *
 * Two things had to be true together to fix it, and either one alone changes
 * nothing:
 *
 *  1. **The font has to travel with the subtitles.** `ffmpeg/custom` takes at
 *     most two wired inputs, and the burn already spends both on the picture
 *     and the cues, so the font cannot ride beside them. It rides INSIDE
 *     them: the subtitles filter loads font attachments out of the file it is
 *     handed, so the SRT and the font are muxed into one mkv first.
 *  2. **A style has to ask for it by name.** libass matches an attached font
 *     by family and will not fall back to one for a missing glyph. Attaching
 *     the font and leaving the style alone renders exactly the same boxes,
 *     byte for byte: that was measured too. So the burn also carries
 *     `force_style='FontName=<family>'`, spelled exactly as the font's own
 *     name table spells it.
 *
 * One font, singular. `force_style` names one family, so a timeline whose
 * cues mix Devanagari and Han can only be given one of them and has to say so
 * about the other.
 */

export interface SubtitleFont {
  /**
   * The family name libass matches on, exactly as the font's name table
   * spells it. `test/caption-font.test.ts` reads the file and fails if this
   * string and the file ever disagree: a family name that is a guess is a
   * render full of boxes that nothing else catches.
   */
  family: string;
  /** The file under `public/fonts`. */
  file: string;
  /** What it covers, for the message when a script has none. */
  script: string;
}

/**
 * Where the fonts live, and why it is `public/`.
 *
 * The upload happens in a route handler, so the file is read from disk at
 * request time. `public/` is the one directory a Next build is guaranteed to
 * carry through unchanged, and a font that is missing at runtime is the same
 * boxes we are here to remove.
 */
export const FONT_DIR = 'public/fonts';

/**
 * The fonts that ship with the app.
 *
 * Adding one is this entry plus the file. Keep the family exactly as the font
 * reports it, spaces and all: `NotoSansDevanagari` matches nothing and renders
 * boxes with no error anywhere. `test/caption-font.test.ts` opens each file
 * and fails if the family, the script's coverage or Latin's ever disagree
 * with what is written here.
 *
 * Latin matters in every one of them because `force_style` applies to the
 * whole cue, so the named font draws the English in a line as well as the
 * Hindi. Every Noto here was checked for it.
 *
 * The Indic and south-east Asian files are the variable fonts from
 * `google/fonts`, whose default instance is Regular. The CJK three are the
 * static Regular subsets from `notofonts/noto-cjk`, on purpose: the variable
 * CJK fonts default to weight 100, and libass renders a variable font at its
 * default instance, so those would have come out hairline rather than as
 * boxes. A bug you can only see by looking at it.
 */
export const BUNDLED: readonly SubtitleFont[] = [
  { script: 'Devanagari', family: 'Noto Sans Devanagari', file: 'NotoSansDevanagari.ttf' },
  { script: 'Bengali', family: 'Noto Sans Bengali', file: 'NotoSansBengali.ttf' },
  { script: 'Gurmukhi', family: 'Noto Sans Gurmukhi', file: 'NotoSansGurmukhi.ttf' },
  { script: 'Gujarati', family: 'Noto Sans Gujarati', file: 'NotoSansGujarati.ttf' },
  { script: 'Odia', family: 'Noto Sans Oriya', file: 'NotoSansOriya.ttf' },
  { script: 'Tamil', family: 'Noto Sans Tamil', file: 'NotoSansTamil.ttf' },
  { script: 'Telugu', family: 'Noto Sans Telugu', file: 'NotoSansTelugu.ttf' },
  { script: 'Kannada', family: 'Noto Sans Kannada', file: 'NotoSansKannada.ttf' },
  { script: 'Malayalam', family: 'Noto Sans Malayalam', file: 'NotoSansMalayalam.ttf' },
  { script: 'Sinhala', family: 'Noto Sans Sinhala', file: 'NotoSansSinhala.ttf' },
  { script: 'Thai', family: 'Noto Sans Thai', file: 'NotoSansThai.ttf' },
  { script: 'Lao', family: 'Noto Sans Lao', file: 'NotoSansLao.ttf' },
  { script: 'Khmer', family: 'Noto Sans Khmer', file: 'NotoSansKhmer.ttf' },
  { script: 'Myanmar', family: 'Noto Sans Myanmar', file: 'NotoSansMyanmar.ttf' },
  { script: 'Ethiopic', family: 'Noto Sans Ethiopic', file: 'NotoSansEthiopic.ttf' },
  { script: 'Chinese', family: 'Noto Sans SC', file: 'NotoSansSC.otf' },
  { script: 'Japanese', family: 'Noto Sans JP', file: 'NotoSansJP.otf' },
  { script: 'Korean', family: 'Noto Sans KR', file: 'NotoSansKR.otf' },
];

/**
 * The scripts the render server's own font already draws.
 *
 * Measured by burning one line per script and looking at the result, not
 * read off a font's advertised coverage. Common and Inherited are the
 * punctuation, digits and combining marks that belong to no script and would
 * otherwise make every line look like it needed a font.
 */
const SERVER_DRAWS =
  /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * Except the emoji, which belong to no script and are not there either.
 *
 * Emoji are Script=Common, so the line above would wave every one of them
 * through. Burning a row of them says otherwise, and says something finer:
 * `✅ ❌ 🔥` come back as boxes while `☺ ★ ✓` draw. That is exactly the
 * Emoji_Presentation line, the characters that default to a colour glyph, so
 * that is what this excludes rather than a block range that would cost the
 * three that work.
 *
 * Nothing here bundles an emoji font, so these are reported and not fixed.
 * Saying "that tick will be a box" is the whole of what we can do about it,
 * and it is a great deal better than saying nothing.
 */
const EMOJI = /\p{Emoji_Presentation}/u;

/**
 * Scripts by name, for the message.
 *
 * Only for naming: what decides is `SERVER_DRAWS`, so a script missing from
 * this table is still counted, still reported and still stops us claiming the
 * burn is fine. It is reported by its characters instead of its name, which
 * is worse to read and not wrong, and that is the right way round. A list
 * that decided things would be a rule with a hole in it: the first script
 * nobody thought of would ship boxes in silence.
 */
const NAMED: readonly { script: string; re: RegExp }[] = [
  { script: 'Devanagari', re: /\p{Script=Devanagari}/u },
  { script: 'Bengali', re: /\p{Script=Bengali}/u },
  { script: 'Gurmukhi', re: /\p{Script=Gurmukhi}/u },
  { script: 'Gujarati', re: /\p{Script=Gujarati}/u },
  { script: 'Odia', re: /\p{Script=Oriya}/u },
  { script: 'Tamil', re: /\p{Script=Tamil}/u },
  { script: 'Telugu', re: /\p{Script=Telugu}/u },
  { script: 'Kannada', re: /\p{Script=Kannada}/u },
  { script: 'Malayalam', re: /\p{Script=Malayalam}/u },
  { script: 'Sinhala', re: /\p{Script=Sinhala}/u },
  { script: 'Thai', re: /\p{Script=Thai}/u },
  { script: 'Lao', re: /\p{Script=Lao}/u },
  { script: 'Khmer', re: /\p{Script=Khmer}/u },
  { script: 'Myanmar', re: /\p{Script=Myanmar}/u },
  { script: 'Tibetan', re: /\p{Script=Tibetan}/u },
  { script: 'Ethiopic', re: /\p{Script=Ethiopic}/u },
  { script: 'Chinese', re: /\p{Script=Han}/u },
  { script: 'Japanese', re: /[\p{Script=Hiragana}\p{Script=Katakana}]/u },
  { script: 'Korean', re: /\p{Script=Hangul}/u },
];

/**
 * How characters are described when they belong to no script we can name.
 *
 * All of them together, not one entry each: a line of an unnamed script is
 * dozens of characters, and a message that lists dozens of them is a message
 * nobody reads to the end of.
 */
const describe = (chars: readonly string[]): string => {
  const shown = chars.slice(0, 3)
    .map((ch) => `"${ch}" (U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')})`);
  const rest = chars.length - shown.length;
  return `characters like ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`;
};

export interface FontNeed {
  /** The font to attach, or null when the server's own is enough. */
  font: SubtitleFont | null;
  /**
   * Scripts in the cues that nothing here has a font for, in the words of
   * the message. Empty means nothing is missing.
   */
  missing: string[];
  /**
   * Scripts we DO have a font for and cannot use, because the burn names one
   * family and another script got it.
   *
   * Kept apart from `missing` because they are different sentences to the
   * person reading them: one is answered by adding a file, and the other
   * cannot be answered at all without a style per cue. Telling someone to go
   * and find a font they already have is the kind of message that costs an
   * afternoon.
   */
  crowdedOut: string[];
}

/**
 * The font these captions need, and what will still come out as boxes.
 *
 * `text` is the caption text, not the SRT: the timestamps and the index
 * numbers are Latin digits and would say every file is fine.
 */
export function fontForCaptions(text: string): FontNeed {
  // one bucket per script, counted, because the font to attach is the one
  // that covers the most of the text and not the one that happens to be first
  const counts = new Map<string, number>();
  const unnamed = new Map<string, number>();

  for (const ch of text) {
    if (SERVER_DRAWS.test(ch) && !EMOJI.test(ch)) continue;
    const named = NAMED.find((n) => n.re.test(ch));
    const bucket = named ? counts : unnamed;
    const key = named ? named.script : ch;
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }

  /**
   * A CJK script is decided by the company it keeps, not by the count.
   *
   * Most of a Japanese sentence is kanji, which is Script=Han, so counting
   * alone hands every Japanese caption to the Chinese font and renders it in
   * Chinese letterforms. Kana beside Han mean the Han is Japanese. Hangul
   * mean it is Korean, and `Noto Sans KR` covers Han and kana as well.
   *
   * Measured from the cmaps, which is what makes the direction of each fold
   * safe: SC covers simplified, traditional, the Japan-only kanji and kana,
   * and only Hangul is missing from it. JP has no simplified characters and
   * KR has neither those nor the Japan-only kanji.
   *
   * The cost is one honest limitation: a timeline carrying Japanese cues AND
   * simplified Chinese ones folds to Japanese, whose font has no simplified
   * characters, and those cues come out as boxes with nothing said. There is
   * one FontName and no way to tell a Chinese kanji from a Japanese one, so
   * the fix for that is a per cue style, not a better guess here.
   */
  for (const [script, takes] of [['Korean', ['Chinese', 'Japanese']], ['Japanese', ['Chinese']]] as const) {
    if (!counts.has(script)) continue;
    for (const taken of takes) {
      const n = counts.get(taken);
      if (n === undefined) continue;
      counts.set(script, (counts.get(script) ?? 0) + n);
      counts.delete(taken);
    }
  }

  const strays: [string, number][] = unnamed.size
    ? [[describe([...unnamed.keys()]), [...unnamed.values()].reduce((a, b) => a + b, 0)]]
    : [];
  const ranked = [...counts, ...strays].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!ranked.length) return { font: null, missing: [], crowdedOut: [] };

  // there is one FontName, so it goes to the commonest script we actually
  // have a font for. Every other script in the cues is reported, including
  // one we could have covered had it not lost the count.
  const winner = ranked.find(([script]) => BUNDLED.some((f) => f.script === script));
  const font = winner ? BUNDLED.find((f) => f.script === winner[0]) ?? null : null;

  const rest = ranked.map(([script]) => script).filter((script) => script !== font?.script);
  const have = (script: string) => BUNDLED.some((f) => f.script === script);
  return {
    font,
    missing: rest.filter((script) => !have(script)),
    crowdedOut: rest.filter(have),
  };
}
