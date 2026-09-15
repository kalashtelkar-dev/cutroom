'use client';

/**
 * Pipelines: build a graph from a description, then let the compiler argue.
 *
 * A developer describes what the pipeline should do. The recipes here are
 * real chains of catalogue operations, every one of them checked with
 * `getNode` before `GraphBuilder` is allowed to place it, so a typo is a
 * refusal at the call site rather than a compile error two round trips later.
 *
 * Then the exchange, in order and on screen: build, preflight, and only then
 * the server. `preflight()` answers ten of the twelve compiler codes offline
 * from the committed catalogue, so most failures never need the round trip,
 * and the difference between an instant repair loop and a 300ms one is the
 * difference between three rounds that feel free and three that do not.
 * POST /v1/pipelines/validate stores nothing and costs nothing, and it is
 * the only editor-API endpoint this whole tab touches.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  GraphBuilder, isEngine, nodeOp, preflight,
  type Graph, type GraphNode,
} from '@/lib/editor-api/graph.ts';
import { extractAudioGraph, EXTRACT_AUDIO_NAME } from '@/lib/pipelines/extract-audio.ts';
import { getNode, NODE_LIST, enginesInUse } from '@/lib/editor-api/catalogue.ts';
import {
  addInput, addOperation, addOutput, canWire, emptyGraph, inPorts, moveNode,
  outPorts, removeNode, searchOperations, unwire, wire,
} from '@/lib/editor-api/edit-graph.ts';
import { pipelineIdFrom, readPipelineReply } from '@/lib/editor-api/pipeline-ref.ts';
import type { WorkbenchStore } from './useWorkbench.ts';

// ── recipes ────────────────────────────────────────────────────────────

interface Recipe {
  name: string;
  /** Words in the description that select this chain. */
  keys: string[];
  /** Every operation it will place, checked against the catalogue first. */
  ops: string[];
  compose: () => Graph;
}

/**
 * Starter recipes verified against the live catalogue and offline preflight.
 *
 * Each recipe wires real catalogue nodes with valid schema parameters and
 * passes preflight before hitting the API.
 */
const RECIPES: Recipe[] = [
  {
    name: 'Extract audio (WAV)',
    keys: ['extract audio', 'audio', 'wav', 'soundtrack', 'rip audio'],
    ops: ['ffmpeg/extract-audio'],
    compose: () => extractAudioGraph(),
  },
  {
    name: 'Speech to subtitles (SRT)',
    keys: ['subtitle', 'subtitles', 'srt', 'transcribe', 'caption', 'captions'],
    ops: ['whisperx/subtitle'],
    compose: () => {
      const b = new GraphBuilder();
      const src = b.input('video', 'file:video');
      const sub = b.op('whisperx', 'subtitle', { formats: ['srt'] });
      const out = b.output(['subtitles']);
      b.wire(src, 'value', sub, 'input').wire(sub, 'files', out, 'subtitles');
      return b.build();
    },
  },
  {
    name: 'Animated preview GIF',
    keys: ['gif', 'preview gif', 'animated gif', 'thumbnail animation'],
    ops: ['ffmpeg/gif'],
    compose: () => {
      const b = new GraphBuilder();
      const src = b.input('video', 'file:video');
      const gif = b.op('ffmpeg', 'gif', { fps: 15, width: 480 });
      const out = b.output(['gif']);
      b.wire(src, 'value', gif, 'input').wire(gif, 'file', out, 'gif');
      return b.build();
    },
  },
];


/** The chain whose words the description hits hardest. Ties go to the longer word. */
function pickRecipe(description: string): Recipe | null {
  const p = ` ${description.toLowerCase()} `;
  let best: Recipe | null = null;
  let score = 0;
  for (const r of RECIPES) {
    const s = r.keys.reduce((sum, k) => sum + (p.includes(k) ? k.length : 0), 0);
    if (s > score) { score = s; best = r; }
  }
  return best;
}

// ── the log ────────────────────────────────────────────────────────────

type Tone = 'ok' | 'bad' | 'flat';
interface LogRow { id: number; stage: string; text: string; note: string; tone: Tone }

interface ValidateReply {
  compiles?: boolean;
  source?: string;
  issues?: { code?: string; message?: string }[];
  error?: string;
  status?: number;
}

// ── the tab ────────────────────────────────────────────────────────────

const NODE_W = 132;
const NODE_H = 42;

/**
 * Engine colours, from the tokens rather than from a palette of their own.
 * Blue is for data in this design and a graph is data, so the engines that
 * carry pictures and sound sit on the blue end and the model engines on the
 * warm end.
 */
const PALETTE_COLOURS = [
  'var(--blue)',
  'var(--wb)',
  'var(--orange)',
  'var(--green)',
  'var(--yellow)',
  'var(--wave)',
  'var(--red)',
  'var(--wb-dim)',
  'var(--ctl-on)',
  'var(--t2)',
];

const ENGINE_COLOUR: Record<string, string> = Object.fromEntries(
  enginesInUse().map((eng, idx) => [eng, PALETTE_COLOURS[idx % PALETTE_COLOURS.length]]),
);
const colourOf = (engine: string) => ENGINE_COLOUR[engine] ?? 'var(--t3)';

const GRAPH_STORAGE_KEY = 'cutroom:workbench:graph';
const PIPELINES_INDEX_KEY = 'cutroom:workbench:pipelines_index';

export interface SavedPipelineEntry {
  id: string;
  name: string;
  nodeCount: number;
  updatedAt: number;
  graph: Graph;
}

function loadSavedPipelinesIndex(): SavedPipelineEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PIPELINES_INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as SavedPipelineEntry[];
  } catch {
    // fallback
  }
  return [];
}

function savePipelinesIndex(list: SavedPipelineEntry[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(PIPELINES_INDEX_KEY, JSON.stringify(list));
  } catch {
    // quota
  }
}

function loadSavedGraph(): Graph {
  if (typeof window === 'undefined') return emptyGraph();
  try {
    const raw = localStorage.getItem(GRAPH_STORAGE_KEY);
    if (!raw) return emptyGraph();
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
      return parsed as Graph;
    }
  } catch {
    // fallback
  }
  return emptyGraph();
}

export function Pipelines({ wb }: { wb: WorkbenchStore }) {
  const [description, setDescription] = useState('');
  const [paste, setPaste] = useState('');
  const [pipelineRef, setPipelineRef] = useState('');
  const [graph, setGraph] = useState<Graph>(() => loadSavedGraph());
  const [title, setTitle] = useState('Untitled pipeline');
  const [vocab, setVocab] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [publishedId, setPublishedId] = useState<string | null>(null);
  const [savedPipelines, setSavedPipelines] = useState<SavedPipelineEntry[]>(() => loadSavedPipelinesIndex());
  const [history, setHistory] = useState<Graph[]>([]);
  const [future, setFuture] = useState<Graph[]>([]);
  const dragInitialGraph = useRef<Graph | null>(null);

  const applyGraphChange = useCallback((next: Graph | ((prev: Graph) => Graph)) => {
    setGraph((current) => {
      const resolved = typeof next === 'function' ? next(current) : next;
      if (resolved === current) return current;
      setHistory((h) => [...h.slice(-40), current]);
      setFuture([]);
      return resolved;
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setFuture((f) => [graph, ...f]);
      setGraph(prev);
      return h.slice(0, -1);
    });
  }, [graph]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setHistory((h) => [...h, graph]);
      setGraph(next);
      return f.slice(1);
    });
  }, [graph]);

  const saveToLibrary = useCallback((g: Graph, pipelineTitle: string) => {
    const entry: SavedPipelineEntry = {
      id: `pipe_${Date.now().toString(36)}`,
      name: pipelineTitle.trim() || 'Untitled pipeline',
      nodeCount: g.nodes.length,
      updatedAt: Date.now(),
      graph: g,
    };
    setSavedPipelines((prev) => {
      const next = [entry, ...prev.filter((p) => p.name !== entry.name)];
      savePipelinesIndex(next);
      return next;
    });
  }, []);

  const deleteFromLibrary = useCallback((id: string) => {
    setSavedPipelines((prev) => {
      const next = prev.filter((p) => p.id !== id);
      savePipelinesIndex(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (
        ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'z') ||
        ((e.metaKey || e.ctrlKey) && e.key === 'y')
      ) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  /** The port a wire is being drawn from, or null. */
  const [arm, setArm] = useState<{ node: string; port: string; type: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [palette, setPalette] = useState('');
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });

  // 5.6: Persist workbench graph across reloads
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(graph));
      } catch {
        // quota exceeded or private mode
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [graph]);

  const canvas = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);
  const from = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);

  const push = useCallback((stage: string, text: string, note = '', tone: Tone = 'flat') => {
    seq.current += 1;
    const row: LogRow = { id: seq.current, stage, text, note, tone };
    setLog((prev) => [...prev, row]);
    return row.id;
  }, []);

  const replace = useCallback((id: number, note: string, tone: Tone) => {
    setLog((prev) => prev.map((r) => (r.id === id ? { ...r, note, tone } : r)));
  }, []);

  const bounds = useMemo(() => measure(graph.nodes), [graph]);

  const fit = useCallback(() => {
    const el = canvas.current;
    if (!el) return;
    const k = Math.min(
      Math.max(Math.min((el.clientWidth - 40) / bounds.w, (el.clientHeight - 40) / bounds.h), 0.32),
      1.25,
    );
    setView({ k, x: (el.clientWidth - bounds.w * k) / 2, y: (el.clientHeight - bounds.h * k) / 2 });
  }, [bounds]);

  /**
   * A hidden pane has no width, so fitting one produces nonsense. The tabs
   * keep every pane mounted, which means the first honest measurement is the
   * moment this one becomes visible.
   */
  const visible = wb.tab === 'pipelines';
  useLayoutEffect(() => { if (visible) fit(); }, [visible, fit]);

  /** Zoom about the middle of the canvas, so the thing you are looking at stays put. */
  const zoom = useCallback((factor: number) => {
    const el = canvas.current;
    if (!el) return;
    setView((v) => {
      const k = Math.min(1.8, Math.max(0.25, v.k * factor));
      const cx = el.clientWidth / 2;
      const cy = el.clientHeight / 2;
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    });
  }, []);

  // Dragging the ground pans it. The Fit and zoom buttons do the same job for
  // anyone not using a pointer, so nothing here is the only way to see a node.
  const onDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.wbp-node')) return;
    from.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [view]);

  const onMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const start = from.current;
    if (!start) return;
    setView((v) => ({ ...v, x: start.vx + (e.clientX - start.px), y: start.vy + (e.clientY - start.py) }));
  }, []);

  const onUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    from.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  /** Preflight, then the server. The order is the point. */
  const check = useCallback(async (g: Graph) => {
    const localId = push('preflight', 'offline, from the committed catalogue', 'checking', 'flat');
    const issues = preflight(g);
    if (issues.length) {
      replace(localId, `${issues.length} issue${issues.length === 1 ? '' : 's'}`, 'bad');
      for (const d of issues) push('', `${d.code}: ${d.message}`, d.node ?? '', 'bad');
      push('server', 'POST /api/graph/validate', 'not asked, it fails here first', 'flat');
      return;
    }
    replace(localId, 'clean', 'ok');

    const remoteId = push('server', 'POST /api/graph/validate', 'waiting', 'flat');
    try {
      const res = await fetch('/api/graph/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ graph: g }),
      });
      const reply = (await res.json()) as ValidateReply;
      if (reply.error) {
        replace(remoteId, `${reply.status ?? res.status}: ${reply.error}`, 'bad');
        return;
      }
      const bad = reply.issues ?? [];
      replace(remoteId, bad.length ? `${bad.length} issue${bad.length === 1 ? '' : 's'}` : 'compiles', bad.length ? 'bad' : 'ok');
      for (const d of bad) push('', `${d.code ?? 'error'}: ${d.message ?? ''}`, '', 'bad');
    } catch (e) {
      // Offline is the normal case for this repo, and preflight already had
      // the last useful word, so say so rather than pretending it failed.
      replace(remoteId, `unreachable, ${(e as Error).message}`, 'bad');
      push('', 'preflight is clean, so the graph is sound as far as the catalogue knows', '', 'flat');
    }
  }, [push, replace]);

  const build = useCallback(async () => {
    const q = description.trim();
    if (busy) return;
    if (!q) { wb.notify('Describe what the pipeline should do'); return; }
    setBusy(true);
    setLog([]);
    setSelected(null);

    const recipe = pickRecipe(q);
    if (!recipe) {
      push('build', `nothing in the catalogue answers to "${q}"`, 'declined', 'bad');
      push('', `try naming an outcome: ${RECIPES.map((r) => r.name.toLowerCase()).join(', ')}`, '', 'flat');
      setBusy(false);
      return;
    }
    push('build', `${recipe.name}: ${recipe.ops.join(' then ')}`, `${recipe.ops.length} operations`, 'ok');

    const missing = recipe.ops.filter((key) => !getNode(key));
    if (missing.length) {
      // the catalogue is committed, so this means it moved under us
      push('catalogue', `not in the catalogue: ${missing.join(', ')}`, 'stopped', 'bad');
      setBusy(false);
      return;
    }
    push('catalogue', `${recipe.ops.length} operations exist, ports and params read from the spec`, 'checked', 'ok');

    const g = recipe.compose();
    applyGraphChange(g);
    setTitle(recipe.name);
    setVocab(recipe.keys);
    saveToLibrary(g, recipe.name);
    push('build', `${g.nodes.length} nodes, ${g.edges.length} edges, every node positioned`, 'built', 'ok');

    await check(g);
    setBusy(false);
  }, [busy, description, push, check, wb, applyGraphChange, saveToLibrary]);

  const importJson = useCallback(async () => {
    if (busy) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(paste);
    } catch (e) {
      setLog([]);
      push('import', 'that is not JSON', (e as Error).message, 'bad');
      return;
    }
    const candidate = (parsed as { graph?: Graph }).graph ?? (parsed as Graph);
    if (!Array.isArray(candidate?.nodes) || !Array.isArray(candidate?.edges)) {
      setLog([]);
      push('import', 'a graph needs a nodes array and an edges array', 'rejected', 'bad');
      return;
    }
    setBusy(true);
    setLog([]);
    setSelected(null);
    applyGraphChange(candidate);
    setTitle('imported graph');
    setVocab(operationsOf(candidate).map((key) => key.split('/')[1]));
    saveToLibrary(candidate, 'Imported graph');
    push('import', `${candidate.nodes.length} nodes, ${candidate.edges.length} edges`, 'parsed', 'ok');
    await check(candidate);
    setBusy(false);
  }, [busy, paste, push, check, applyGraphChange, saveToLibrary]);

  /**
   * Open a pipeline that is already in the account, by its id.
   *
   * The same two checks as every other way in: what the server sent is
   * preflighted here first and only then sent back for it to compile. A
   * pipeline the server already says compiles can still fail preflight, if the
   * catalogue committed here has moved since it was built, and that is worth
   * knowing before it is edited rather than after.
   */
  const fetchById = useCallback(async () => {
    if (busy) return;
    const id = pipelineIdFrom(pipelineRef);
    if (!id) {
      setLog([]);
      push('fetch', 'no pipeline id in that', 'expected something like tpl_75e1fLGX64dF', 'bad');
      return;
    }
    setBusy(true);
    setLog([]);
    setSelected(null);
    const row = push('fetch', `GET /api/pipelines/${id}`, 'waiting', 'flat');
    try {
      const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}`);
      const reply = await res.json().catch(() => null);
      const read = readPipelineReply(reply);
      if ('error' in read) {
        replace(row, `${res.status}: ${read.error}`, 'bad');
        setBusy(false);
        return;
      }
      const p = read.pipeline;
      replace(row, `"${p.name}", version ${p.version ?? '?'}`, 'ok');
      push('', `${p.graph.nodes.length} nodes, ${p.graph.edges.length} edges`,
        p.published ? 'published' : 'draft', 'flat');
      if (p.description) {
        // one line of it: a pipeline built elsewhere carries an essay, and the
        // first sentence is the part that says what you just opened
        const first = p.description.split(/[.\n]/)[0].trim();
        if (first) push('', first.length > 96 ? `${first.slice(0, 96)}...` : first, '', 'flat');
      }
      if (!p.graph.nodes.length) {
        push('', 'that pipeline has no nodes in it', 'nothing to edit', 'bad');
      }
      if (!p.compiles) {
        push('', `the server holds it as not compiling, with ${p.issueCount} issue(s)`, '', 'bad');
      }
      applyGraphChange(p.graph);
      setTitle(p.name);
      setVocab(operationsOf(p.graph).map((key) => key.split('/')[1]));
      saveToLibrary(p.graph, p.name);
      await check(p.graph);
    } catch (e) {
      replace(row, `unreachable, ${(e as Error).message}`, 'bad');
    } finally {
      setBusy(false);
    }
  }, [busy, pipelineRef, push, replace, check, applyGraphChange, saveToLibrary]);

  const node = graph.nodes.find((n) => n.id === selected) ?? null;
  const clean = useMemo(() => preflight(graph).length === 0, [graph]);

  const publish = useCallback(async () => {
    if (publishing || !clean || !graph.nodes.length) return;
    setPublishing(true);
    push('publish', `publishing pipeline "${title}" to account...`, 'submitting', 'ok');
    try {
      const res = await fetch('/api/pipelines/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: title, graph }),
      });
      const data = await res.json();
      if (!res.ok) {
        push('publish', data.error || 'publish failed', `status ${res.status}`, 'bad');
      } else {
        saveToLibrary(graph, title);
        setPublishedId(data.id);
        // the id is the only handle on it, so put it where it can be used
        setPipelineRef(data.id);
        push('publish', `published as ${data.id}`, 'pipeline is live in account', 'ok');
      }
    } catch (e) {
      push('publish', 'network error publishing', (e as Error).message, 'bad');
    } finally {
      setPublishing(false);
    }
  }, [publishing, clean, graph, title, push, saveToLibrary, setPublishedId]);

  const updateParam = useCallback((nodeId: string, key: string, value: unknown) => {
    applyGraphChange((g) => ({
      ...g,
      nodes: g.nodes.map((n) => {
        if (n.id !== nodeId || !isEngine(n)) return n;
        const nextParams = { ...n.params };
        if (value === undefined || value === '') {
          delete nextParams[key];
        } else {
          nextParams[key] = value;
        }
        return { ...n, params: nextParams };
      }),
    }));
  }, [applyGraphChange]);

  return (
    <>
      <style href="cutroom-wb-pipes" precedence="medium">{CSS}</style>

      <div className="wb-col wbp-side">
        <div className="wb-sec">Catalogue recipes<span className="wb-grow" /><b>{RECIPES.length}</b></div>
        <div className="wb-scroll">
          {RECIPES.map((r) => (
            <button
              key={r.name}
              type="button"
              className="wbp-recipe"
              onClick={() => setDescription(r.keys[0])}
            >
              <span className="n">{r.name}</span>
              <span className="o">{r.ops.join(', ')}</span>
            </button>
          ))}
        </div>

        <div className="wb-sec">
          Saved pipelines<span className="wb-grow" /><b>{savedPipelines.length}</b>
        </div>
        {savedPipelines.length > 0 ? (
          <div className="wb-scroll" style={{ maxHeight: 160 }}>
            {savedPipelines.map((p) => (
              <div
                key={p.id}
                className="wbp-recipe"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <button
                  type="button"
                  style={{ flex: 1, background: 'none', border: 0, textAlign: 'left', cursor: 'pointer', padding: 0 }}
                  onClick={() => {
                    applyGraphChange(p.graph);
                    setTitle(p.name);
                    setVocab(operationsOf(p.graph).map((key) => key.split('/')[1]));
                    wb.notify(`Loaded pipeline "${p.name}"`);
                  }}
                >
                  <span className="n">{p.name}</span>
                  <span className="o">{p.nodeCount} node{p.nodeCount === 1 ? '' : 's'}</span>
                </button>
                <button
                  type="button"
                  className="wb-btn sm"
                  style={{ padding: '2px 6px', fontSize: 10 }}
                  onClick={() => deleteFromLibrary(p.id)}
                  title="Delete from saved pipelines"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="wb-sec">Import<span className="wb-grow" /><b>same two checks</b></div>
        <form
          className="wbp-fetch"
          onSubmit={(e) => { e.preventDefault(); void fetchById(); }}
        >
          <label className="wbp-sr" htmlFor="wbp-id">Open a pipeline by its id</label>
          <input
            id="wbp-id"
            className="wb-input"
            spellCheck={false}
            value={pipelineRef}
            placeholder="tpl_75e1fLGX64dF"
            onChange={(e) => setPipelineRef(e.target.value)}
            title="A pipeline id, or a URL or a line of JSON with one in it"
          />
          <button type="submit" className="wb-btn" disabled={busy || !pipelineRef.trim()}>
            {busy ? 'Opening' : 'Open'}
          </button>
        </form>
        {publishedId ? (
          <div className="wbp-note">
            last published: <code>{publishedId}</code>
          </div>
        ) : null}
        <div className="wbp-import">
          <label className="wbp-sr" htmlFor="wbp-json">Paste a graph as JSON</label>
          <textarea
            id="wbp-json"
            className="wbp-json"
            spellCheck={false}
            value={paste}
            placeholder='{"version":1,"nodes":[],"edges":[]}'
            onChange={(e) => setPaste(e.target.value)}
          />
          <button type="button" className="wb-btn" disabled={busy || !paste.trim()} onClick={() => void importJson()}>
            Validate pasted graph
          </button>
        </div>
      </div>

      <div className="wb-col wbp-main">
        <div className="wb-sec">
          Graph<span className="wb-grow" />
          <b>{title}</b>
          <span className={clean ? 'wbp-ok' : 'wbp-bad'}>{clean ? 'preflight clean' : 'preflight objects'}</span>
          <button
            type="button"
            className="wb-btn sm"
            disabled={history.length === 0}
            onClick={undo}
            title="Undo graph edit (Cmd+Z)"
          >
            ↶ Undo
          </button>
          <button
            type="button"
            className="wb-btn sm"
            disabled={future.length === 0}
            onClick={redo}
            title="Redo graph edit (Cmd+Shift+Z)"
          >
            ↷ Redo
          </button>
          {graph.nodes.length > 0 ? (
            <button
              type="button"
              className="wb-btn sm"
              onClick={() => {
                saveToLibrary(graph, title);
                wb.notify(`Saved "${title}" to library`);
              }}
              title="Save pipeline graph to local library"
            >
              Save
            </button>
          ) : null}
          {clean && graph.nodes.length > 0 ? (
            <button
              type="button"
              className="wb-btn pri sm"
              disabled={busy || publishing}
              onClick={() => void publish()}
              title="Publish this pipeline to your account"
            >
              {publishing ? 'Publishing...' : 'Publish'}
            </button>
          ) : null}
          <button type="button" className="wb-btn sm" onClick={() => zoom(1 / 1.18)} aria-label="Zoom out">-</button>
          <button type="button" className="wb-btn sm" onClick={() => zoom(1.18)} aria-label="Zoom in">+</button>
          <button type="button" className="wb-btn sm" onClick={fit}>Fit</button>
        </div>

        <form className="wbp-build" onSubmit={(e) => { e.preventDefault(); void build(); }}>
          <label className="wbp-sr" htmlFor="wbp-desc">Describe a pipeline to build</label>
          <input
            id="wbp-desc"
            className="wb-input wbp-desc"
            spellCheck={false}
            value={description}
            placeholder={RECIPES.length
              ? 'Describe a pipeline to build'
              : 'No recipes yet. Add operations below and wire them up.'}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button type="submit" className="wb-btn pri" disabled={busy || !RECIPES.length}>
            {busy ? 'Building' : 'Build'}
          </button>
        </form>

        {/*
          Build it by hand.

          A recipe is somebody's chain written into the source. This is the
          other way in and the one that does not need a code change: search
          the catalogue, place an operation, wire a port to a port. The rules
          that refuse a wire are the compiler's own, so a wire the canvas
          allows is a wire that compiles.
        */}
        <div className="wbp-add-bar">
          <input
            className="wb-input"
            spellCheck={false}
            value={palette}
            placeholder={`Add an operation, ${NODE_LIST.length} in the catalogue`}
            onChange={(e) => setPalette(e.target.value)}
          />
          <button
            type="button"
            className="wb-btn sm"
            onClick={() => {
              const name = window.prompt('Name this input. It becomes the key a run is started with.', 'video');
              if (!name) return;
              const type = window.prompt('What type does it carry?', 'file:video');
              if (!type) return;
              applyGraphChange((g) => addInput(g, name, type, place(g)));
            }}
          >
            + Input
          </button>
          <button
            type="button"
            className="wb-btn sm"
            onClick={() => {
              const fields = window.prompt('What does the pipeline return? Comma separated.', 'file');
              if (!fields) return;
              applyGraphChange((g) => addOutput(g, fields.split(','), place(g)));
            }}
          >
            + Output
          </button>
          {graph.nodes.length ? (
            <button type="button" className="wb-btn sm" onClick={() => { try { localStorage.removeItem(GRAPH_STORAGE_KEY); } catch {} applyGraphChange(emptyGraph()); setSelected(null); setArm(null); }}>
              Clear
            </button>
          ) : null}
        </div>

        {palette.trim() ? (
          <ul className="wbp-palette">
            {searchOperations(palette, NODE_LIST).slice(0, 12).map((key) => {
              const spec = getNode(key);
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => {
                      applyGraphChange((g) => addOperation(g, key, place(g)));
                      setPalette('');
                    }}
                  >
                    <b style={{ color: colourOf(key.slice(0, key.indexOf('/'))) }}>{key}</b>
                    <span>{spec?.summary ?? ''}</span>
                  </button>
                </li>
              );
            })}
            {!searchOperations(palette, NODE_LIST).length ? (
              <li className="none">Nothing in the catalogue matches that.</li>
            ) : null}
          </ul>
        ) : null}

        {arm || refused ? (
          <p className={refused ? 'wbp-wiring bad' : 'wbp-wiring'}>
            {refused ?? `Wiring from ${arm?.node}.${arm?.port}, which carries ${arm?.type}. Click an input port, or the same port again to stop.`}
          </p>
        ) : null}

        {log.length ? (
          <ol className="wbp-log">
            {log.map((r) => (
              <li key={r.id} className={r.tone}>
                <span className="m">{r.stage}</span>
                <span className="t">{r.text}</span>
                <span className="s">{r.note}</span>
              </li>
            ))}
          </ol>
        ) : null}

        <div
          className="wbp-canvas"
          ref={canvas}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <div
            className="wbp-world"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
          >
            <svg className="wbp-wires" width={bounds.w} height={bounds.h} aria-hidden="true">
              {graph.edges.map((e) => {
                const from = graph.nodes.find((n) => n.id === e?.from?.node);
                const to = graph.nodes.find((n) => n.id === e?.to?.node);
                if (!from || !to) return null;
                const ax = at(from).x - bounds.x + NODE_W;
                const ay = at(from).y - bounds.y + 14;
                const bx = at(to).x - bounds.x;
                const by = at(to).y - bounds.y + 14;
                const dx = Math.max(26, Math.abs(bx - ax) * 0.45);
                const edgeKey = e.id ?? `${e.from.node}.${e.from.port}-${e.to.node}.${e.to.port}`;
                return (
                  <g key={edgeKey} className="wbp-edge-g">
                    <path
                      d={`M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="12"
                      style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                      onClick={(evt) => {
                        evt.stopPropagation();
                        applyGraphChange((g) => unwire(g, e.id));
                      }}
                    >
                      <title>{`Click to delete wire from ${e.from.node}.${e.from.port} to ${e.to.node}.${e.to.port}`}</title>
                    </path>
                    <path
                      d={`M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`}
                      fill="none"
                      strokeWidth="1.6"
                      opacity="0.6"
                      stroke={colourOf(isEngine(from) ? from.engine : 'util')}
                      style={{ pointerEvents: 'none' }}
                    />
                  </g>
                );
              })}
            </svg>
            {graph.nodes.map((n) => (
              <div
                key={n.id}
                className={`wbp-node${selected === n.id ? ' on' : ''}`}
                style={{ left: at(n).x - bounds.x, top: at(n).y - bounds.y }}
                onPointerDown={(e) => {
                  if ((e.target as HTMLElement).closest('.wbp-port')) return;
                  setSelected(n.id);
                  dragInitialGraph.current = graph;
                  const box = e.currentTarget.getBoundingClientRect();
                  drag.current = {
                    id: n.id,
                    dx: (e.clientX - box.left) / view.k,
                    dy: (e.clientY - box.top) / view.k,
                  };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d || d.id !== n.id) return;
                  const host = canvas.current?.getBoundingClientRect();
                  if (!host) return;
                  const x = (e.clientX - host.left - view.x) / view.k - d.dx + bounds.x;
                  const y = (e.clientY - host.top - view.y) / view.k - d.dy + bounds.y;
                  setGraph((g) => moveNode(g, n.id, { x: Math.round(x), y: Math.round(y) }));
                }}
                onPointerUp={() => {
                  if (dragInitialGraph.current && dragInitialGraph.current !== graph) {
                    const init = dragInitialGraph.current;
                    setHistory((h) => [...h.slice(-40), init]);
                    setFuture([]);
                  }
                  drag.current = null;
                  dragInitialGraph.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                  dragInitialGraph.current = null;
                }}
              >
                <span className="h">
                  <i style={{ background: colourOf(isEngine(n) ? n.engine : n.kind) }} />
                  <span className="o">{label(n)}</span>
                  <button
                    type="button"
                    className="wbp-del"
                    aria-label={`Delete ${label(n)}`}
                    title="Delete this node and its wires"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      applyGraphChange((g) => removeNode(g, n.id));
                      setSelected((cur) => (cur === n.id ? null : cur));
                      setArm((a) => (a?.node === n.id ? null : a));
                    }}
                  >
                    ✕
                  </button>
                </span>
                <span className="p">{isEngine(n) ? n.engine : n.kind}</span>

                <span className="wbp-ports in">
                  {inPorts(n).map((port) => {
                    const verdict = arm
                      ? canWire(graph, { node: arm.node, port: arm.port }, { node: n.id, port: port.name })
                      : null;
                    return (
                      <button
                        key={port.name}
                        type="button"
                        className="wbp-port"
                        data-ok={verdict?.ok ? 'true' : undefined}
                        data-no={verdict && !verdict.ok ? 'true' : undefined}
                        title={verdict && !verdict.ok
                          ? verdict.why
                          : `${port.name}: ${port.accepts.join(' or ') || 'anything'}${port.list ? ', a list' : ''}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => {
                          if (!arm) { setRefused('Click an output port first, then an input.'); return; }
                          const v = canWire(graph, { node: arm.node, port: arm.port }, { node: n.id, port: port.name });
                          if (!v.ok) { setRefused(v.why ?? 'that wire is not allowed'); return; }
                          applyGraphChange((g) => wire(g, { node: arm.node, port: arm.port }, { node: n.id, port: port.name }));
                          setArm(null);
                          setRefused(null);
                        }}
                      >
                        <i />{port.name}
                      </button>
                    );
                  })}
                </span>

                <span className="wbp-ports out">
                  {outPorts(n).map((port) => (
                    <button
                      key={port.name}
                      type="button"
                      className="wbp-port"
                      data-armed={arm?.node === n.id && arm.port === port.name ? 'true' : undefined}
                      title={`${port.name} carries ${port.type}${port.list ? ', many' : ''}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        setRefused(null);
                        setArm((a) => (a?.node === n.id && a.port === port.name
                          ? null
                          : { node: n.id, port: port.name, type: port.type }));
                      }}
                    >
                      {port.name}<i />
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="wb-col wbp-insp">
        <div className="wb-sec">Node</div>
        {node ? <NodeInspector node={node} graph={graph} onUpdateParam={updateParam} /> : (
          <p className="wb-empty">Pick a node. Tab reaches every one of them.</p>
        )}
        <div className="wb-sec">Its intel card<span className="wb-grow" /><b>{clean ? 'what the router would get' : 'once it compiles'}</b></div>
        {clean ? <CardPreview graph={graph} title={title} vocab={vocab} wb={wb} /> : (
          <p className="wb-empty">A graph that does not compile gets no card: the router would route to something that cannot run.</p>
        )}
      </div>
    </>
  );
}

/**
 * Where a newly placed node goes.
 *
 * To the right of everything, on the row of whatever it will most likely
 * follow. Stacking them all at the origin means every new node lands on top
 * of the last one and the first thing you do is drag them apart.
 */
function place(g: Graph): { x: number; y: number } {
  if (!g.nodes.length) return { x: 0, y: 0 };
  const xs = g.nodes.map((n) => n.position?.x ?? 0);
  const ys = g.nodes.map((n) => n.position?.y ?? 0);
  return { x: Math.max(...xs) + 190, y: Math.round(ys.reduce((a, b) => a + b, 0) / ys.length) };
}

// ── pieces ─────────────────────────────────────────────────────────────

/**
 * Where a node sits, defensively.
 *
 * A pasted graph is allowed to be wrong: a node with no position is exactly
 * what preflight exists to report, and the canvas has to survive long enough
 * to show that report rather than throwing while drawing it.
 */
function at(n: GraphNode): { x: number; y: number } {
  const p = n?.position;
  return {
    x: typeof p?.x === 'number' && Number.isFinite(p.x) ? p.x : 0,
    y: typeof p?.y === 'number' && Number.isFinite(p.y) ? p.y : 0,
  };
}

function measure(nodes: GraphNode[]) {
  if (!nodes.length) return { x: 0, y: 0, w: NODE_W, h: NODE_H };
  const xs = nodes.map((n) => at(n).x);
  const ys = nodes.map((n) => at(n).y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x + NODE_W, h: Math.max(...ys) - y + NODE_H };
}

function label(n: GraphNode): string {
  if (isEngine(n)) return n.operation;
  if (n.kind === 'input') return n.name;
  if (n.kind === 'output') return 'output';
  // a pasted graph may carry a kind the compiler does not know; preflight
  // reports it as bad_node, and the canvas says what it actually found
  return String((n as { kind?: unknown }).kind ?? 'unknown');
}

const operationsOf = (g: Graph): string[] =>
  [...new Set(g.nodes.filter(isEngine).map(nodeOp))];

function NodeInspector({
  node,
  graph,
  onUpdateParam,
}: {
  node: GraphNode;
  graph: Graph;
  onUpdateParam?: (nodeId: string, key: string, value: unknown) => void;
}) {
  const inbound = graph.edges.filter((e) => e.to.node === node.id);
  const outbound = graph.edges.filter((e) => e.from.node === node.id);
  const spec = isEngine(node) ? getNode(nodeOp(node)) : undefined;

  const schemaProps = (spec?.params?.properties ?? {}) as Record<string, {
    type?: string | string[];
    enum?: readonly unknown[];
    default?: unknown;
    minimum?: number;
    maximum?: number;
    description?: string;
  }>;
  const nodeParams = (isEngine(node) ? node.params : {}) ?? {};
  const allParamKeys = Array.from(new Set([...Object.keys(schemaProps), ...Object.keys(nodeParams)]));

  return (
    <div className="wb-scroll wbp-fields">
      <Field k="id" v={node.id} />
      <Field k="kind" v={node.kind} />
      {isEngine(node) ? <Field k="operation" v={nodeOp(node)} colour={colourOf(node.engine)} /> : null}
      {spec ? <Field k="runs" v={spec.gpu ? 'queued job, gpu' : spec.local ? 'in process' : 'queued job'} /> : null}
      {node.kind === 'input' ? <Field k="type" v={`${node.type}${node.required ? ', required' : ', optional'}`} /> : null}
      {node.kind === 'output' ? <Field k="fields" v={(node.fields ?? []).join(', ') || 'none'} /> : null}
      <Field k="position" v={node.position ? `${at(node).x}, ${at(node).y}` : 'missing, which the server rejects'} />
      {spec?.summary ? <p className="wbp-summary">{spec.summary}</p> : null}

      {isEngine(node) && allParamKeys.length > 0 ? (
        <>
          <span className="wbp-gt">params</span>
          {allParamKeys.map((key) => {
            const prop = schemaProps[key];
            const currentVal = nodeParams[key];
            const isReq = spec?.params?.required?.includes(key);

            if (prop?.enum && Array.isArray(prop.enum)) {
              return (
                <div key={key} className="wbp-param-row">
                  <div className="wbp-param-head">
                    <span className="k">{key}{isReq ? '*' : ''}</span>
                    <span className="t">enum</span>
                  </div>
                  <select
                    className="wbp-param-select"
                    value={currentVal !== undefined ? String(currentVal) : ''}
                    onChange={(e) => onUpdateParam?.(node.id, key, e.target.value)}
                  >
                    <option value="">(default)</option>
                    {prop.enum.map((opt) => (
                      <option key={String(opt)} value={String(opt)}>
                        {String(opt)}
                      </option>
                    ))}
                  </select>
                </div>
              );
            }

            if (prop?.type === 'boolean') {
              const checked = Boolean(currentVal ?? prop.default ?? false);
              return (
                <div key={key} className="wbp-param-row">
                  <label className="wbp-param-bool">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => onUpdateParam?.(node.id, key, e.target.checked)}
                    />
                    <span>{key}{isReq ? '*' : ''}</span>
                  </label>
                </div>
              );
            }

            if (prop?.type === 'number' || prop?.type === 'integer') {
              return (
                <div key={key} className="wbp-param-row">
                  <div className="wbp-param-head">
                    <span className="k">{key}{isReq ? '*' : ''}</span>
                    <span className="t">{String(prop.type)}</span>
                  </div>
                  <input
                    type="number"
                    className="wbp-param-input"
                    value={currentVal !== undefined ? String(currentVal) : ''}
                    placeholder={prop.default !== undefined ? String(prop.default) : ''}
                    min={prop.minimum}
                    max={prop.maximum}
                    onChange={(e) => {
                      const val = e.target.value;
                      onUpdateParam?.(node.id, key, val === '' ? undefined : Number(val));
                    }}
                  />
                </div>
              );
            }

            return (
              <div key={key} className="wbp-param-row">
                <div className="wbp-param-head">
                  <span className="k">{key}{isReq ? '*' : ''}</span>
                  <span className="t">{prop?.type ? String(prop.type) : 'param'}</span>
                </div>
                <input
                  type="text"
                  className="wbp-param-input"
                  value={currentVal !== undefined ? (typeof currentVal === 'string' ? currentVal : JSON.stringify(currentVal)) : ''}
                  placeholder={prop?.default !== undefined ? String(prop.default) : ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    onUpdateParam?.(node.id, key, val);
                  }}
                />
              </div>
            );
          })}
        </>
      ) : null}

      <span className="wbp-gt">wires</span>
      {inbound.length === 0 && outbound.length === 0 ? <p className="wbp-summary">Nothing is wired to this node.</p> : null}
      {inbound.map((e) => <Field key={e.id} k={`in ${e.to.port}`} v={`from ${e.from.node}.${e.from.port}`} />)}
      {outbound.map((e) => <Field key={e.id} k={`out ${e.from.port}`} v={`to ${e.to.node}.${e.to.port}`} />)}
    </div>
  );
}

function Field({ k, v, colour }: { k: string; v: string; colour?: string }) {
  return (
    <div className="wbp-field">
      <span className="k">{k}</span>
      <span className="v" style={colour ? { color: colour } : undefined}>{v}</span>
    </div>
  );
}

/**
 * What the intel card for this graph would say.
 *
 * A pipeline that arrives without a card cannot be routed to, so the import
 * was pointless; a pipeline whose card claims words another card already owns
 * quietly steals that card's traffic. Both are worth seeing before the card
 * is written, which is why the generated vocabulary is shown with its
 * collisions rather than after them.
 */
function CardPreview({ graph, title, vocab, wb }: { graph: Graph; title: string; vocab: string[]; wb: WorkbenchStore }) {
  const ops = operationsOf(graph);
  const engines = [...new Set(graph.nodes.filter(isEngine).map((n) => n.engine))];
  const gpu = ops.some((key) => getNode(key)?.gpu);
  const steps = ops.length;
  const cost = gpu
    ? `${Math.max(20, steps * 9)}-${Math.max(60, steps * 22)}s, gpu`
    : `${Math.max(3, steps * 3)}-${Math.max(12, steps * 8)}s, cpu`;
  const rung = steps <= 1 ? 2 : 3;
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const outputs = graph.nodes.filter((n) => n.kind === 'output').flatMap((n) => n.fields ?? []);
  const inputs = graph.nodes.filter((n) => n.kind === 'input').map((n) => `${n.name}: ${n.type}`);

  return (
    <div className="wb-scroll wbp-card">
      <Field k="id" v={id} />
      <Field k="kind" v="pipeline" />
      <Field k="rung" v={`${rung}, ${steps} step${steps === 1 ? '' : 's'}`} />
      <Field k="cost" v={cost} />
      <Field k="engines" v={engines.join(', ') || 'none'} />
      <Field k="in" v={inputs.join(', ') || 'none'} />
      <Field k="out" v={outputs.join(', ') || 'none'} />
      <span className="wbp-gt">operations</span>
      {ops.map((key) => <Field key={key} k={key.split('/')[0]} v={key.split('/')[1]} colour={colourOf(key.split('/')[0])} />)}
      <span className="wbp-gt">match, if it claimed its own words</span>
      <div className="wbp-vocab">
        {vocab.map((term) => {
          const others = wb.claimants.get(term) ?? [];
          return (
            <span key={term} className={others.length ? 'wbp-term clash' : 'wbp-term'}>
              {term}
              {others.length ? <i>claimed by {others.join(', ')}</i> : null}
            </span>
          );
        })}
      </div>
      <p className="wbp-summary">
        The generator can read the operations, the engines and the cost off the graph.
        What it cannot read is <b>When NOT to use it</b>, and that section is the one
        that keeps a card from winning prompts it has no business winning.
      </p>

      <AddToIntel graph={graph} title={title} vocab={vocab} id={id} />
    </div>
  );
}

/**
 * Write the card this preview describes.
 *
 * The two sections a graph cannot supply are asked for here, and the card is
 * refused without them. The first version of this wrote "WRITE THIS" into
 * `When NOT to use it` and shipped: the card went live, started winning
 * prompts, and the note telling someone to fix it was inside the thing that
 * needed fixing. A placeholder in a generator is a placeholder in production.
 */
function AddToIntel({
  graph, title, vocab, id,
}: {
  graph: Graph;
  title: string;
  vocab: string[];
  id: string;
}) {
  const [when, setWhen] = useState('');
  const [notWhen, setNotWhen] = useState('');
  const [veto, setVeto] = useState('');
  const [example, setExample] = useState('');
  const [state, setState] = useState<{ busy: boolean; said: string | null; ok: boolean; exists: boolean }>(
    { busy: false, said: null, ok: false, exists: false },
  );

  const short = (t: string) => t.trim().length < 25;
  const ready = vocab.length > 0 && !short(when) && !short(notWhen);

  const write = async () => {
    setState((p) => ({ ...p, busy: true, said: null, ok: false }));
    try {
      const { generateCard, CardIncomplete } = await import('@/lib/intel/generate.ts');
      let draft;
      try {
        draft = generateCard(graph, title, vocab, {
          whenToUse: when,
          whenNotToUse: notWhen,
          veto: veto.split(',').map((v) => v.trim()).filter(Boolean),
          examples: example.trim() ? [example.trim()] : [],
        });
      } catch (e) {
        if (e instanceof CardIncomplete) {
          setState({ busy: false, ok: false, exists: false, said: e.message });
          return;
        }
        throw e;
      }

      const res = await fetch('/api/intel/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: draft.id, markdown: draft.markdown, overwrite: state.exists }),
      });
      const body = await res.json();
      if (!res.ok) {
        setState({
          busy: false, ok: false, exists: Boolean(body.exists),
          said: body.exists
            ? `${draft.id}.md exists already. Press again to replace it.`
            : String(body.error ?? `the write answered ${res.status}`),
        });
        return;
      }
      setState({
        busy: false, ok: true, exists: true,
        said: `Wrote ${body.file}. Run ${body.next} to put it in front of the router.`,
      });
    } catch (e) {
      setState({ busy: false, ok: false, exists: false, said: (e as Error).message });
    }
  };

  return (
    <div className="wbp-add">
      <span className="wbp-gt">what a graph cannot tell you</span>

      <label className="wbp-field">
        <span>When to use it</span>
        <textarea
          value={when}
          rows={3}
          placeholder="Why someone reaches for this, in their words."
          onChange={(e) => setWhen(e.target.value)}
        />
      </label>

      <label className="wbp-field">
        <span>When NOT to use it</span>
        <textarea
          value={notWhen}
          rows={4}
          placeholder="The cases that look like this one and are not. This is what stops it stealing another card's traffic."
          onChange={(e) => setNotWhen(e.target.value)}
        />
      </label>

      <label className="wbp-field">
        <span>Veto words, comma separated</span>
        <input
          value={veto}
          placeholder="transcribe, subtitle"
          onChange={(e) => setVeto(e.target.value)}
        />
      </label>

      <label className="wbp-field">
        <span>An example sentence</span>
        <input
          value={example}
          placeholder="Something a person would really say, not already claimed above."
          onChange={(e) => setExample(e.target.value)}
        />
      </label>

      <button type="button" className="wb-btn pri sm" disabled={state.busy || !ready} onClick={() => void write()}>
        {state.busy ? 'Writing...' : state.exists && !state.ok ? 'Replace the card' : 'Add to Intel'}
      </button>

      {!vocab.length ? (
        <span className="wbp-said">A card that claims no words can never win a prompt, so there is nothing to write.</span>
      ) : !ready ? (
        <span className="wbp-said">
          Both sections are required. A card written without them wins prompts it
          cannot serve, which is what the one above this was doing.
        </span>
      ) : null}

      {state.said ? <span className="wbp-said" data-ok={state.ok ? 'true' : undefined}>{state.said}</span> : null}
      <span className="wbp-said">Lands as <code>lib/intel/cards/{id}.md</code>.</span>
    </div>
  );
}

const CSS = `
.wbp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.wbp-side{width:250px;flex:none}
.wbp-main{flex:1}
.wbp-insp{width:280px;flex:none}

.wbp-recipe{
  display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--edge);
  background:none;padding:7px 11px;cursor:pointer;font-family:inherit;
}
.wbp-recipe:hover{background:var(--panel-2)}
.wbp-recipe .n{display:block;font-size:11.5px;color:var(--t1)}
.wbp-recipe .o{display:block;font-family:var(--mono);font-size:9px;color:var(--t3);margin-top:2px;line-height:1.4}
.wbp-fetch{padding:9px 11px 0;display:flex;gap:6px;flex:none}
.wbp-fetch .wb-input{flex:1;min-width:0;font-family:var(--mono);font-size:10.5px;padding:6px 8px}
.wbp-note{
  padding:5px 11px 0;font-family:var(--mono);font-size:9.5px;color:var(--t3);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.wbp-note code{color:var(--t2)}
.wbp-import{padding:9px 11px;display:flex;flex-direction:column;gap:7px;flex:none}
.wbp-json{
  height:110px;resize:none;background:var(--app);border:1px solid var(--edge-soft);border-radius:4px;
  color:var(--t2);font-family:var(--mono);font-size:10.5px;padding:8px;line-height:1.5;
}
.wbp-json:focus{outline:none;border-color:var(--wb)}

.wbp-build{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--edge);background:var(--app);flex:none}
.wbp-desc{flex:1;min-width:0;font-size:12px;padding:6px 9px}
.wbp-ok{font-family:var(--mono);font-size:10px;color:var(--green)}
.wbp-bad{font-family:var(--mono);font-size:10px;color:var(--red)}

.wbp-log{
  list-style:none;margin:0;padding:0;flex:none;max-height:172px;overflow-y:auto;
  background:var(--panel-2);border-bottom:1px solid var(--edge);
}
.wbp-log li{
  display:flex;gap:8px;align-items:baseline;padding:5px 12px;border-bottom:1px solid var(--edge);
  font-family:var(--mono);font-size:10.5px;
}
.wbp-log .m{flex:none;width:62px;color:var(--wb)}
.wbp-log .t{flex:1;min-width:0;color:var(--t2);word-break:break-word}
.wbp-log .s{flex:none;color:var(--t3)}
.wbp-log li.ok .s{color:var(--green)}
.wbp-log li.bad .s{color:var(--red)}
.wbp-log li.bad .t{color:var(--red)}

.wbp-canvas{
  flex:1;min-height:0;position:relative;overflow:hidden;background:var(--tl);cursor:grab;touch-action:none;
  background-image:
    linear-gradient(var(--app) 1px, transparent 1px),
    linear-gradient(90deg, var(--app) 1px, transparent 1px);
  background-size:22px 22px;
}
.wbp-canvas:active{cursor:grabbing}
.wbp-world{position:absolute;top:0;left:0;transform-origin:0 0}
.wbp-wires{position:absolute;top:0;left:0;overflow:visible;pointer-events:none}
.wbp-node{
  position:absolute;width:132px;padding:0;border:1px solid var(--edge-soft);border-radius:3px;
  background:var(--head);cursor:grab;font-family:inherit;text-align:left;
  box-shadow:var(--sink);
  /* NOT overflow:hidden. The ports sit outside the box on purpose, and
     hiding the overflow clipped them back inside it, where a wire appears to
     start from the middle of the node it leaves. */
  overflow:visible;
}
.wbp-node:active{cursor:grabbing}
/* the clipping the node used to do, moved to the one thing that needs it */
.wbp-node .h{overflow:hidden;border-radius:2px 2px 0 0}
.wbp-node:hover{border-color:var(--t3)}
.wbp-node{touch-action:none}
.wbp-del{
  width:13px;height:13px;flex:none;border:0;background:none;padding:0;cursor:pointer;
  color:var(--t3);font-size:10px;line-height:1;opacity:0;border-radius:2px;
}
.wbp-node:hover .wbp-del,.wbp-del:focus-visible{opacity:1}
.wbp-del:hover{color:var(--orange);background:var(--panel)}

/* ports sit on the edges they wire from, so a wire starts where it looks
   like it starts */
.wbp-ports{position:absolute;top:26px;display:flex;flex-direction:column;gap:2px}
.wbp-ports.in{left:-7px;align-items:flex-start}
.wbp-ports.out{right:-7px;align-items:flex-end}
.wbp-port{
  display:flex;align-items:center;gap:3px;border:0;background:none;padding:0;cursor:pointer;
  font-family:var(--mono);font-size:8.5px;color:var(--t3);white-space:nowrap;
}
.wbp-port i{
  width:7px;height:7px;border-radius:50%;flex:none;display:block;
  background:var(--panel);border:1px solid var(--edge-soft);
}
.wbp-port:hover{color:var(--t1)}
.wbp-port:hover i{border-color:var(--t2)}
.wbp-port[data-armed] i{background:var(--wb);border-color:var(--wb)}
.wbp-port[data-armed]{color:var(--wb)}
.wbp-port[data-ok] i{background:var(--green);border-color:var(--green)}
.wbp-port[data-no]{opacity:.35}

.wbp-add-bar{display:flex;gap:6px;align-items:center;padding:0 0 6px}
.wbp-add-bar .wb-input{flex:1;min-width:0}
.wbp-palette{
  list-style:none;margin:0 0 6px;padding:0;max-height:180px;overflow-y:auto;
  border:1px solid var(--edge);border-radius:4px;background:var(--panel);
}
.wbp-palette li+li{border-top:1px solid var(--edge)}
.wbp-palette button{
  display:flex;flex-direction:column;gap:1px;width:100%;text-align:left;border:0;
  background:none;cursor:pointer;padding:5px 9px;font-family:inherit;
}
.wbp-palette button:hover{background:var(--panel-2)}
.wbp-palette b{font-family:var(--mono);font-size:10.5px;font-weight:600}
.wbp-palette span{font-size:10.5px;color:var(--t3);line-height:1.4}
.wbp-palette .none{padding:7px 9px;font-size:10.5px;color:var(--t3)}
.wbp-wiring{
  margin:0 0 6px;font-family:var(--mono);font-size:10px;color:var(--wb);
  padding:5px 8px;border-radius:4px;background:var(--wb-wash);
}
.wbp-wiring.bad{color:var(--orange);background:var(--orange-dim)}
.wbp-node.on{border-color:var(--wb);box-shadow:0 0 0 1px var(--wb)}
.wbp-node .h{
  display:flex;align-items:center;gap:5px;padding:4px 7px;background:var(--panel-2);
  border-bottom:1px solid var(--edge);
}
.wbp-node .h i{width:3px;height:12px;border-radius:1px;flex:none;display:block}
.wbp-node .o{
  font-family:var(--mono);font-size:10px;color:var(--t1);flex:1;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.wbp-node .p{display:block;padding:3px 7px;font-family:var(--mono);font-size:9px;color:var(--t3)}

.wbp-fields,.wbp-card{padding:10px 12px}
.wbp-add{display:flex;flex-direction:column;gap:7px;padding:10px 0 2px;border-top:1px solid var(--edge);margin-top:10px}
.wbp-said{font-size:10.5px;line-height:1.5;color:var(--t3)}
.wbp-said[data-ok]{color:var(--green)}
.wbp-said code{font-family:var(--mono);color:var(--t2)}
.wbp-field{display:flex;flex-direction:column;gap:3px}
.wbp-field>span{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--t3)}
.wbp-field textarea,.wbp-field input{
  background:var(--app);border:1px solid var(--edge-soft);border-radius:4px;color:var(--t1);
  font-family:var(--ui);font-size:11.5px;padding:5px 6px;resize:vertical;min-width:0;width:100%;
}
.wbp-field textarea:focus,.wbp-field input:focus{outline:none;border-color:var(--wb)}
.wbp-field{display:flex;gap:8px;align-items:baseline;padding:2px 0;font-family:var(--mono);font-size:10.5px}
.wbp-field .k{width:82px;flex:none;color:var(--t3);overflow:hidden;text-overflow:ellipsis}
.wbp-field .v{flex:1;min-width:0;color:var(--t2);word-break:break-word}
.wbp-param-row{display:flex;flex-direction:column;gap:3px;margin:4px 0 6px}
.wbp-param-head{display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:10px}
.wbp-param-head .k{color:var(--t3)}
.wbp-param-head .t{color:var(--t3);font-size:9px}
.wbp-param-input,.wbp-param-select{
  background:var(--app);border:1px solid var(--edge-soft);border-radius:3px;
  color:var(--t1);font-family:var(--mono);font-size:11px;padding:3px 6px;width:100%;
}
.wbp-param-input:focus,.wbp-param-select:focus{outline:none;border-color:var(--wb)}
.wbp-param-bool{
  display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10.5px;
  color:var(--t2);cursor:pointer;padding:2px 0;
}
.wbp-param-bool input{cursor:pointer}
.wbp-gt{
  display:block;margin:10px 0 4px;font-family:var(--mono);font-size:9px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--t3);
}
.wbp-summary{margin:9px 0 0;font-size:11px;line-height:1.55;color:var(--t3)}
.wbp-summary b{color:var(--t2)}
.wbp-vocab{display:flex;flex-wrap:wrap;gap:5px}
.wbp-term{
  font-family:var(--mono);font-size:10px;padding:2px 6px;border-radius:4px;
  background:var(--panel-2);border:1px solid var(--edge-soft);color:var(--t2);
}
.wbp-term.clash{border-color:var(--yellow)}
.wbp-term i{font-style:normal;color:var(--yellow);margin-left:6px}
`;
