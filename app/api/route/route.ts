import { NextResponse } from 'next/server';
import { route, validatePlan, actualRung } from '@/lib/router/plan.ts';
import { blurb, getCard } from '@/lib/intel/index.ts';

/**
 * Route a prompt to a tool.
 *
 * Nothing here touches the network or costs anything, retrieval is
 * arithmetic over the intel cards and plan validation is schema checking
 * against the committed catalogue. The result carries its own explanation:
 * which phrases fired, what it beat, and by how much.
 */
export async function POST(request: Request) {
  let body: { prompt?: string; strictLadder?: boolean };
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

  return NextResponse.json({
    prompt,
    plan: result.plan,
    declined: result.declined ?? null,
    // what the plan will actually cost, which can exceed what the card claims
    reachedRung: result.plan ? actualRung(result.plan.steps) : null,
    problems,
    summary: card ? blurb(card) : null,
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
