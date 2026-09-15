import { NextResponse } from 'next/server';
import { preflight, type Graph } from '@/lib/editor-api/graph.ts';
import { validateGraph, allProblems, EditorApiError } from '@/lib/editor-api/client.ts';

/**
 * Compile a graph.
 *
 * Preflight runs first because it is instant and answers ten of the twelve
 * compiler codes from the committed catalogue. When it finds something, we
 * return that and skip the round trip, a repair loop that gets its answer in
 * a millisecond feels different from one that waits 300ms each round.
 *
 * When preflight is clean, the server gets the last word: capacity, engine
 * versions and `port_unavailable` are only knowable there.
 */
export async function POST(request: Request) {
  let graph: Graph;
  try {
    const body = await request.json();
    graph = (body.graph ?? body) as Graph;
  } catch {
    return NextResponse.json({ error: 'expected a JSON graph' }, { status: 400 });
  }

  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
    return NextResponse.json({ error: 'a graph needs nodes and edges' }, { status: 400 });
  }

  const local = preflight(graph);
  if (local.length) {
    return NextResponse.json({ compiles: false, source: 'preflight', issues: local });
  }

  try {
    const remote = await validateGraph(graph);
    // normalise to one field so a caller does not have to know that the
    // server splits mistakes from omissions, while keeping both available
    return NextResponse.json({ ...remote, issues: allProblems(remote), source: 'server' });
  } catch (e) {
    if (e instanceof EditorApiError) {
      return NextResponse.json(
        { error: e.message, status: e.status, body: e.body, source: 'server' },
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    }
    throw e;
  }
}
