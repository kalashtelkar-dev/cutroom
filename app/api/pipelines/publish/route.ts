import { NextResponse } from 'next/server';
import { importPipeline, publishPipeline, EditorApiError } from '@/lib/editor-api/client.ts';
import type { Graph } from '@/lib/editor-api/graph.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: { name?: string; graph?: Graph; description?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const name = String(body.name ?? 'Pipeline').trim();
  const graph = body.graph;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return NextResponse.json({ error: 'valid graph with nodes and edges is required' }, { status: 400 });
  }

  try {
    const imported = await importPipeline(name, graph, body.description ?? null);
    const published = await publishPipeline(imported.id);
    return NextResponse.json({
      id: imported.id,
      name: imported.name,
      published: true,
      result: published,
    });
  } catch (e) {
    if (e instanceof EditorApiError) {
      return NextResponse.json(
        { error: e.message, status: e.status, body: e.body },
        { status: e.status || 500 },
      );
    }
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

