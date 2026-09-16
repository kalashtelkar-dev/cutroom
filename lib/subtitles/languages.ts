/**
 * Languages, for the two different questions a subtitle run asks.
 *
 * They are genuinely two questions and it took a measurement to see it:
 *
 *  - **What is being SPOKEN** is an ISO code on a whisperx param. Omitting it
 *    means "detect it", which is usually right and occasionally very wrong:
 *    the pipeline this tool replaced turned Hindi speech into English text and
 *    said nothing. `languageProbability` comes back with every run, so a bad
 *    guess can at least be reported.
 *  - **What the subtitles should READ in** is a free-text language name on
 *    `vllm/translate`, whose own schema gives "hinglish", "hindi", "english"
 *    as examples. It is not an ISO code and it is not a fixed list: the model
 *    is being asked in words, so "brazilian portuguese" is a legitimate
 *    answer where `pt-BR` would be a worse one.
 *
 * So this table is not the set of languages the tool supports. It is the set
 * it can RECOGNISE in a sentence somebody typed, which is a smaller and much
 * more practical thing: enough to turn "put hindi subtitles on this" into an
 * answered question instead of a question the user has to answer twice.
 * Anything not in here still works, it just arrives by being typed rather
 * than by being clicked.
 *
 * `whisperx/translate` is deliberately not on this path at all. It is the
 * obvious way to get English and it is the wrong one twice over, both
 * measured against the live API on the same five second Hindi clip:
 *
 *   1. It SILENTLY returns the source language unless `model: large-v3` is
 *      named. Default model, cpu tier: "नमस्ते यह एक परीक्षण है". Same call,
 *      `model: "large-v3"`: "Namaste! This is a test." No error, no flag, no
 *      difference in the job's status. Nothing catches that but reading it.
 *   2. Even when it does translate, it answers
 *      `alignSkipped: "translated text cannot be force-aligned against
 *      source-language audio"` and hands back ONE segment for the whole clip.
 *      Transcribing and then translating the segments keeps the alignment:
 *      the same clip came back as two cues on the words they belong to.
 *
 * A subtitle that sits on screen for the whole clip is the exact defect
 * `cues.ts` exists to work around. So the path is always transcribe, then
 * translate the segments if a different language was asked for.
 */

/** A language this module can pick out of a sentence. */
export interface Language {
  /** The ISO code whisperx wants for the SPOKEN language. */
  code: string;
  /** The name `vllm/translate` is asked in, and the name a chip shows. */
  name: string;
  /** Other spellings people type. Lowercase, matched as whole words. */
  aliases?: readonly string[];
}

/**
 * Ordered, because the first few are the chips that get offered.
 *
 * The head of the list is India plus the languages this editor is most often
 * pointed at; the tail is there to be recognised, not to be offered.
 */
export const LANGUAGES: readonly Language[] = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'Hindi' },
  { code: 'mr', name: 'Marathi' },
  { code: 'bn', name: 'Bengali' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'kn', name: 'Kannada' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'pa', name: 'Punjabi' },
  { code: 'ur', name: 'Urdu' },
  { code: 'es', name: 'Spanish', aliases: ['castellano', 'espanol', 'español'] },
  { code: 'fr', name: 'French', aliases: ['francais', 'français'] },
  { code: 'de', name: 'German', aliases: ['deutsch'] },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ru', name: 'Russian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'fa', name: 'Persian', aliases: ['farsi'] },
  { code: 'tr', name: 'Turkish' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese', aliases: ['mandarin'] },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'pl', name: 'Polish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'he', name: 'Hebrew' },
  { code: 'el', name: 'Greek' },
  { code: 'sw', name: 'Swahili' },
];

const byCode = new Map(LANGUAGES.map((l) => [l.code, l]));

/** A language by its ISO code, or null. */
export const languageByCode = (code: string): Language | null =>
  byCode.get(code.trim().toLowerCase()) ?? null;

/**
 * Its own name, for a code that came back from a run.
 *
 * whisperx answers `language: "hi"`, and "12 captions, in hi" is not a
 * sentence. A code nothing recognises is returned as it stands, because the
 * code is still more use to the reader than silence.
 */
export const languageName = (code: string): string =>
  languageByCode(code)?.name ?? code;

/**
 * Whole-word, so "german" is found in "german subtitles" and "man" is not
 * found in "romanian". Language names have no regex metacharacters in them,
 * but the escape stays: this list is edited by hand and the day somebody adds
 * one with a dot in it should not be the day the matcher starts matching
 * everything.
 */
const mentions = (text: string, word: string): boolean =>
  new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu').test(text);

/**
 * The language named in a sentence, or null.
 *
 * The LONGEST name wins, not the first, so "brazilian portuguese" is not
 * silently reduced to "portuguese" by a list that happens to reach one before
 * the other. Whether a language is worth acting on is the caller's question:
 * "translate this from hindi" and "put hindi subtitles on this" name the same
 * language for opposite purposes, and no amount of looking at the word tells
 * the two apart.
 */
export function languageIn(text: string): Language | null {
  let best: Language | null = null;
  let bestLen = 0;
  for (const lang of LANGUAGES) {
    for (const word of [lang.name, ...(lang.aliases ?? [])]) {
      if (word.length > bestLen && mentions(text, word)) {
        best = lang;
        bestLen = word.length;
      }
    }
  }
  return best;
}
