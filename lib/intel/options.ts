/**
 * The questions a card asks before it runs.
 *
 * A plan used to be a constant: the card held one JSON fence and the router
 * emitted it verbatim. That is right for a tool with one behaviour and wrong
 * for one with a choice in it, and subtitles have two choices that change what
 * the run costs and what comes back. The alternative shapes were a dropdown on
 * the rail, and the rail had exactly that: two dropdowns, Style and Language,
 * wired to nothing, because `runTool` read the target and ignored the params.
 * A control that does not work is worse than no control.
 *
 * So the questions live on the card, beside the plan whose bindings they set,
 * and there is one description of them for the person and for the model.
 *
 * **A question must claim a phrase to take an answer from the prompt.** This
 * is the same rule the cards themselves live under, for the same reason. "Put
 * hindi subtitles on this" names a language once and there are two questions
 * it could be answering; free-text overlap would hand it to whichever question
 * was read first, and "translate from hindi to english" would answer both with
 * the same word. A question that claims nothing in the prompt is asked rather
 * than guessed, and being asked is a click, where guessing wrong is a GPU
 * minute and a timeline full of subtitles in the wrong language.
 *
 * The format, in `## Options`:
 *
 *     ### spoken
 *     ask: What language is the speech in?
 *     claims: spoken in {language}, the audio is {language}
 *     free: language sets spoken={code}
 *     - Detect it
 *     - English: spoken=en
 *     - Hindi: spoken=hi
 *
 * `### id` names the question. Every `key=value` is a binding the plan reads,
 * so the plan and the questions cannot drift apart without a test noticing
 * (`test/options.test.ts` compares the two lists). The first choice is the
 * default. `free:` names a recogniser for an answer nobody listed, and `{...}`
 * in its assignments is filled from what the recogniser found.
 */
import { LANGUAGES, languageIn, type Language } from '../subtitles/languages.ts';

/** What one choice does: the bindings it sets when it is picked. */
export interface Choice {
  label: string;
  /** Binding name → value. Empty is legitimate: "Detect it" sets nothing. */
  sets: Record<string, string | boolean>;
}

/** A recogniser for an answer the card did not list. */
export type FreeKind = 'language';

export interface Question {
  id: string;
  /** The sentence a person is shown. */
  ask: string;
  /**
   * One word for it, once it has been answered.
   *
   * The answered line read `spoken  Hindi`, which is the binding's name and
   * not a word anybody chose. Repeating the whole question there instead
   * would be worse: a settled question is a fact, not a prompt.
   */
  short: string;
  choices: Choice[];
  /** Phrases in a prompt that answer this question, with `{language}` holes. */
  claims: string[];
  /**
   * Take the first choice quietly when nobody says, instead of asking.
   *
   * A question is worth asking when its answer changes what the user gets and
   * they are the only one who knows it. "What language is the speech in?" is
   * not that: the transcriber detects it correctly nearly always, and asking
   * put a click in front of every single subtitle run to confirm a default.
   * The answer is still SETTABLE, by saying so in the prompt or by the
   * dropdown on the rail, and the panel still shows what it assumed, so a
   * detection that went wrong is visible rather than silent.
   */
  assumed: boolean;
  /** How to read an answer nobody listed, and what it then sets. */
  free?: { kind: FreeKind; sets: Record<string, string | boolean> };
}

/** An answer, as chosen or as read out of the prompt. */
export interface Answer {
  questionId: string;
  /**
   * The question's own word, carried on the answer.
   *
   * An answered question is no longer pending, so the panel showing it has
   * nowhere to look the word up: it had the id, printed the id, and the line
   * read `spoken  Hindi`. An answer that cannot say what it answered is half
   * an answer.
   */
  short: string;
  /** What to show: the chip's label, or the language somebody typed. */
  label: string;
  sets: Record<string, string | boolean>;
  /** True when it came out of the prompt rather than off a chip. */
  fromPrompt?: boolean;
  /** True when nobody chose it and the card said to assume it. */
  assumed?: boolean;
}

// ── parsing ─────────────────────────────────────────────────────────────

const csv = (v: string): string[] => v.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * `a=1, b=true` into bindings.
 *
 * `true` and `false` become booleans because a branch is taken on truthiness
 * and the string "false" is true. That was worth one line here and would have
 * been a subtitle run that translated into the language it was already in.
 */
function parseSets(text: string): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const pair of csv(text)) {
    const m = pair.match(/^([A-Za-z_][\w]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    out[m[1]] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return out;
}

/** Every question in a card's `## Options` section, in the order written. */
export function parseOptions(section: string): Question[] {
  if (!section.trim()) return [];
  const out: Question[] = [];
  let current: Question | null = null;

  for (const raw of section.split('\n')) {
    const line = raw.trim();

    const head = line.match(/^###\s+([A-Za-z_][\w-]*)\s*$/);
    if (head) {
      // the id humanised, until the card says otherwise
      current = {
        id: head[1],
        ask: '',
        short: head[1].replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        choices: [],
        claims: [],
        assumed: false,
      };
      out.push(current);
      continue;
    }
    if (!current) continue;

    const ask = line.match(/^ask:\s*(.+)$/i);
    if (ask) { current.ask = ask[1].trim(); continue; }

    const claims = line.match(/^claims:\s*(.+)$/i);
    if (claims) { current.claims = csv(claims[1]); continue; }

    const short = line.match(/^short:\s*(.+)$/i);
    if (short) { current.short = short[1].trim(); continue; }

    const assumed = line.match(/^assumed:\s*(.+)$/i);
    if (assumed) { current.assumed = assumed[1].trim().toLowerCase() === 'true'; continue; }

    const free = line.match(/^free:\s*([a-z-]+)\s+sets\s+(.+)$/i);
    if (free && free[1].toLowerCase() === 'language') {
      current.free = { kind: 'language', sets: parseSets(free[2]) };
      continue;
    }

    const choice = line.match(/^[-*]\s+(.+?)(?::\s*(.*))?$/);
    if (choice) {
      current.choices.push({ label: choice[1].trim(), sets: parseSets(choice[2] ?? '') });
    }
  }

  // A question with no choices cannot be asked and cannot be answered; it is
  // a heading somebody left behind, not an option.
  return out.filter((q) => q.choices.length > 0 && q.ask !== '');
}

/** Every binding name any choice of any question can set. */
export function bindingsSet(questions: readonly Question[]): Set<string> {
  const out = new Set<string>();
  for (const q of questions) {
    for (const c of q.choices) for (const k of Object.keys(c.sets)) out.add(k);
    for (const k of Object.keys(q.free?.sets ?? {})) out.add(k);
  }
  return out;
}

// ── answering from a prompt ─────────────────────────────────────────────

/** Every language name and alias, longest first, as one alternation. */
const LANGUAGE_WORDS = LANGUAGES
  .flatMap((l) => [l.name, ...(l.aliases ?? [])])
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/**
 * A claim phrase as a regex.
 *
 * `{language}` is the only hole, and it captures. The words around it are
 * matched literally with flexible spacing, so a card can write "the audio is
 * {language}" and a person can type "the  audio   is hindi".
 */
function claimPattern(claim: string): RegExp {
  const body = claim
    .trim()
    .split(/\s+/)
    .map((word) =>
      word === '{language}'
        ? `(${LANGUAGE_WORDS})`
        : word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`(^|[^\\p{L}])${body}([^\\p{L}]|$)`, 'iu');
}

/**
 * `{code}` and `{name}` filled in.
 *
 * `{name}` prefers what the person actually typed over the name the table
 * knows. `vllm/translate` is asked for its target in words, not in a code, so
 * "brazilian portuguese" is a better answer than "portuguese" and the table
 * only ever recognised the second half of it. `{code}` has no such freedom:
 * it is an ISO code on a whisperx param and it comes from the table.
 */
const fill = (
  sets: Record<string, string | boolean>,
  lang: Language,
  typed?: string,
): Record<string, string | boolean> =>
  Object.fromEntries(
    Object.entries(sets).map(([k, v]) => [
      k,
      typeof v === 'string'
        ? v.replace(/\{code\}/g, lang.code)
           .replace(/\{name\}/g, (typed ?? lang.name).trim().toLowerCase())
        : v,
    ]),
  );

/**
 * The choice whose own label names this language, or a free-text answer.
 *
 * A listed choice comes first. "English" is on the target list because it sets
 * the same bindings the free recogniser would, and picking the listed one
 * keeps the chip that gets highlighted the one the person would have clicked.
 */
function answerWith(q: Question, lang: Language, typed?: string): Answer | null {
  const listed = q.choices.find((c) => c.label.toLowerCase() === lang.name.toLowerCase());
  if (listed) {
    return { questionId: q.id, short: q.short, label: listed.label, sets: listed.sets, fromPrompt: true };
  }
  if (!q.free) return null;
  const label = (typed ?? lang.name).trim();
  return { questionId: q.id, short: q.short, label, sets: fill(q.free.sets, lang, typed), fromPrompt: true };
}

/**
 * What the prompt already answers, question by question.
 *
 * Questions are read in the order the card writes them, and a claim that
 * fires CONSUMES the words it matched. "Translate this from hindi to english"
 * names two languages for two questions, and without consuming the span the
 * second question would match the first language again: the spoken question
 * claims "from {language}", takes "from hindi" out of the sentence, and the
 * target question is then left looking at "translate this to english".
 */
export function answersInPrompt(
  questions: readonly Question[],
  prompt: string,
): Answer[] {
  let left = ` ${prompt} `;
  const out: Answer[] = [];

  for (const q of questions) {
    for (const claim of q.claims) {
      const m = left.match(claimPattern(claim));
      if (!m) continue;
      const lang = languageIn(m[0]);
      if (!lang) continue;
      const answer = answerWith(q, lang);
      if (!answer) continue;
      out.push(answer);
      // blank the span rather than delete it, so nothing either side of it
      // becomes adjacent and forms a phrase that was never written
      left = left.slice(0, m.index ?? 0) + ' '.repeat(m[0].length) + left.slice((m.index ?? 0) + m[0].length);
      break;
    }
  }
  return out;
}

/** The first choice, which is what the card says to do when nobody says. */
export const defaultAnswer = (q: Question): Answer => ({
  questionId: q.id,
  short: q.short,
  label: q.choices[0].label,
  sets: q.choices[0].sets,
  assumed: true,
});

/**
 * The answers, plus a default for every question the card said to assume.
 *
 * Filling them in here rather than leaving them unset is what keeps the
 * panel honest: the run is told what it assumed, and so is the person. A
 * question that quietly took its default and said nothing would be the same
 * design as a dropdown wired to nothing, which this file exists because of.
 */
export function withAssumed(
  questions: readonly Question[],
  answers: readonly Answer[],
): Answer[] {
  const done = new Set(answers.map((a) => a.questionId));
  return [
    ...answers,
    ...questions.filter((q) => q.assumed && !done.has(q.id)).map(defaultAnswer),
  ];
}

/** Questions still unanswered, in the order they should be asked. */
export const pendingQuestions = (
  questions: readonly Question[],
  answers: readonly Answer[],
): Question[] => {
  const done = new Set(answers.map((a) => a.questionId));
  return questions.filter((q) => !done.has(q.id));
};

/** Every binding a set of answers contributes, later answers winning. */
export function bindingsFrom(answers: readonly Answer[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of answers) Object.assign(out, a.sets);
  return out;
}

/** An answer by the label a person clicked, or null if no such choice. */
export function answerByLabel(q: Question, label: string): Answer | null {
  const choice = q.choices.find((c) => c.label.toLowerCase() === label.trim().toLowerCase());
  if (choice) return { questionId: q.id, short: q.short, label: choice.label, sets: choice.sets };
  // Not a chip: a language somebody typed, which is what `free` is for.
  const lang = q.free ? languageIn(label) : null;
  if (!lang) return null;
  const answer = answerWith(q, lang, label);
  // Typed, not clicked, so it is not `fromPrompt`: the assistant highlights a
  // chip for one and echoes the words for the other.
  return answer ? { ...answer, fromPrompt: false } : null;
}
