import { NextResponse } from 'next/server';
import { route, validatePlan, actualRung } from '@/lib/router/plan.ts';
import {
  answerByLabel, answersInPrompt, bindingsFrom, blurb, getCard, pendingQuestions, withAssumed,
  type Answer, type Question,
} from '@/lib/intel/index.ts';

/**
 * Route a prompt to a tool, and answer as much of it as the prompt already did.
 *
 * Nothing here touches the network or costs anything, retrieval is
 * arithmetic over the intel cards and plan validation is schema checking
 * against the committed catalogue. The result carries its own explanation:
 * which phrases fired, what it beat, and by how much.
 *
 * The client sends back the LABEL it picked, never the bindings behind it.
 * A browser that could name its own bindings could send `rewrite=true` with
 * no target, or a target the card never offered, and the card would stop
 * being the description of what runs. Resolving the label here means the
 * answer comes out of the same card the plan does.
 */

interface Sent { questionId?: unknown; label?: unknown }

/** Turn what the client picked back into answers, dropping anything unknown. */
function resolve(questions: readonly Question[], sent: readonly Sent[]): Answer[] {
  const out: Answer[] = [];
  for (const raw of sent) {
    const q = questions.find((x) => x.id === String(raw?.questionId ?? ''));
    if (!q) continue;
    const answer = answerByLabel(q, String(raw?.label ?? ''));
    if (answer) out.push(answer);
  }
  return out;
}

export async function POST(request: Request) {
  let body: { prompt?: string; strictLadder?: boolean; answers?: Sent[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const prompt = body.prompt?.trim();
  if (!prompt) return NextResponse.json({ error: 'prompt is required' }, { status: 400 });

  const result = route(prompt, { strictLadder: body.strictLadder });
  const problems = result.plan ? validatePlan(result.plan.steps) : [];
  const card = result.plan ? getCard(result.plan.cardId) : undefined;

  /**
   * Answered by hand first, then by the prompt.
   *
   * A chip the person actually clicked outranks a word the matcher found, so
   * changing your mind by answering again works, and the prompt never
   * overrides an explicit choice on the next round trip.
   */
  const questions = card?.questions ?? [];
  const chosen = resolve(questions, body.answers ?? []);
  /**
   * Chosen, then read out of the prompt, then assumed.
   *
   * In that order, because each one is a weaker claim than the last. A card
   * that says to assume a question still loses to a word in the prompt, and
   * both lose to a chip somebody clicked.
   */
  const answers = withAssumed(questions, [
    ...chosen,
    ...answersInPrompt(questions, prompt).filter(
      (a) => !chosen.some((c) => c.questionId === a.questionId),
    ),
  ]);
  const pending = pendingQuestions(questions, answers);

  return NextResponse.json({
    prompt,
    plan: result.plan,
    declined: result.declined ?? null,
    // what the plan will actually cost, which can exceed what the card claims
    reachedRung: result.plan ? actualRung(result.plan.steps) : null,
    problems,
    summary: card ? blurb(card) : null,
    /** Everything still to settle before this can run, in the order to ask. */
    pending,
    answers,
    /** What the answers so far bind, which is what the run will be given. */
    bindings: bindingsFrom(answers),
    considered: result.live.map((h) => ({
      id: h.card.id,
      score: h.adj,
      rung: h.card.rung,
      cost: h.card.cost,
      matched: h.why,
    })),
    vetoed: result.hits
      .filter((h) => h.vetoed)
      .map((h) => ({ id: h.card.id, by: h.vetoedBy })),
  });
}
