import {
  NODE_LIST, PORT_TYPES, DEPENDS_NODES, fanOutPorts,
} from '@/lib/editor-api/catalogue.ts';
import { GraphBuilder, preflight } from '@/lib/editor-api/graph.ts';
import {
  RATES, frames, timeRange, rangeEnd, toTimecode, rateLabel,
} from '@/lib/time/frames.ts';
import { allCards } from '@/lib/intel/index.ts';
import { route } from '@/lib/router/plan.ts';

/**
 * The foundation, reporting on itself.
 *
 * This is scaffolding with real numbers in it rather than a placeholder: it
 * renders from the generated catalogue and runs the preflight checker for
 * real, so a broken import or a stale catalogue shows up as a broken page.
 */

// a graph that should compile, and one that should not
function samples() {
  const good = new GraphBuilder();
  const gsrc = good.input('video', 'file:video');
  const gthumb = good.op('ffmpeg', 'thumbnail', { count: 6, width: 480 });
  const gmont = good.op('imagemagick', 'montage');
  const gout = good.output(['files']);
  good.wire(gsrc, 'value', gthumb, 'input')
      .wire(gthumb, 'frames', gmont, 'input')   // list input: collects the fan-out
      .wire(gmont, 'files', gout, 'files');

  const bad = new GraphBuilder();
  const bsrc = bad.input('video', 'file:video');
  const b1 = bad.op('ffmpeg', 'thumbnail', { count: 4 });
  const b2 = bad.op('ffmpeg', 'thumbnail', { count: 4, atSec: 2 });
  const comp = bad.op('imagemagick', 'composite');
  const bout = bad.output(['file']);
  bad.wire(bsrc, 'value', b1, 'input').wire(bsrc, 'value', b2, 'input')
     .wire(b1, 'frames', comp, 'base').wire(b2, 'frames', comp, 'overlay')
     .wire(comp, 'file', bout, 'file');

  return { good: good.build(), bad: bad.build() };
}

export default function Home() {
  const engines = [...new Set(NODE_LIST.map((n) => n.engine))].sort();
  const fanOut = NODE_LIST.flatMap((n) => fanOutPorts(n)).length;
  const gpu = NODE_LIST.filter((n) => n.gpu).length;
  const { good, bad } = samples();
  const goodIssues = preflight(good);
  const badIssues = preflight(bad);

  const clip = timeRange(frames(240), frames(187));

  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <header className="mb-10">
        <div className="mb-2 flex items-center gap-2.5">
          <span className="block h-4 w-4 rounded-sm bg-gradient-to-br from-[var(--orange)] to-[#d97f1e]" />
          <h1 className="text-xl font-bold tracking-tight">Cutroom</h1>
        </div>
        <p className="max-w-prose text-[var(--t2)]">
          AI video auto-editor for AISuite. Generated footage goes in, an edited
          timeline comes out, and a Resolve-class NLE is there to correct it by
          hand.
        </p>
      </header>

      {/* This page is a self-report. The product is behind these two links,
          and without them it is not findable from the root at all. */}
      <nav aria-label="Open" className="mb-10 grid gap-3 sm:grid-cols-2">
        <Door
          href="/edit"
          accent="var(--orange)"
          title="Editor"
          blurb="Import, cut, and assemble. Media pool, viewer, timeline, inspector and the assistant."
          icon={<EditorIcon />}
        />
        <Door
          href="/workbench"
          accent="var(--wb)"
          title="Workbench"
          blurb="Bench the router on a real prompt, edit an intel card, run the evals, inspect a pipeline."
          icon={<WorkbenchIcon />}
        />
      </nav>

      <Section title="Node catalogue" note="generated from GET /v1/pipelines/nodes">
        <Stats
          rows={[
            ['nodes', String(NODE_LIST.length)],
            ['engines', String(engines.length)],
            ['gpu-bound', `${gpu} of ${NODE_LIST.length}`],
            ['port types', String(PORT_TYPES.length)],
            ['fan-out capable ports', String(fanOut)],
            ['arity decided by params', DEPENDS_NODES.join(', ') || 'none'],
          ]}
        />
        <div className="mt-3 flex flex-wrap gap-1.5">
          {engines.map((e) => (
            <span key={e} className="rounded-sm border border-[var(--edge-soft)] px-2 py-0.5 font-mono text-[11px] text-[var(--t2)]">
              {e}
              <span className="ml-1.5 text-[var(--t3)]">
                {NODE_LIST.filter((n) => n.engine === e).length}
              </span>
            </span>
          ))}
        </div>
      </Section>

      <Section title="Time model" note="integer frames in, RationalTime only at the edge">
        <Stats
          rows={[
            ['project rate', rateLabel(RATES.film)],
            ['clip range', `[${clip.start}, ${rangeEnd(clip)}) · ${clip.duration} frames`],
            ['as timecode', `${toTimecode(clip.start, RATES.film)} → ${toTimecode(rangeEnd(clip), RATES.film)}`],
            ['29.97 drop-frame', `${toTimecode(frames(1799), RATES.ntsc)} then ${toTimecode(frames(1800), RATES.ntsc)}`],
          ]}
        />
      </Section>

      <Section title="Graph preflight" note="the compiler's diagnostics, answered offline">
        <p className="mb-3 text-[var(--t2)]">
          A sound graph and one that reaches for a zip the DAG does not have. Both
          checked here, with no network, and both agree with{' '}
          <code className="font-mono text-[12px] text-[var(--t1)]">POST /v1/pipelines/validate</code>.
        </p>
        <Verdict label="thumbnail ×6 → montage (fan-out collected)" issues={goodIssues} />
        <Verdict label="two fan-outs into one node" issues={badIssues} />
      </Section>

      <Section title="Router" note={`${allCards().length} intel cards · retrieval is arithmetic, so it is testable`}>
        <p className="mb-3 text-[var(--t2)]">
          Each card owns the phrases it answers to. A card that claims nothing in
          the prompt does not act, silence beats a confident guess.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--edge-soft)] text-left">
                <th className="py-1.5 pr-3 font-medium text-[var(--t3)]">prompt</th>
                <th className="py-1.5 pr-3 font-medium text-[var(--t3)]">routes to</th>
                <th className="py-1.5 pr-3 font-medium text-[var(--t3)]">rung</th>
                <th className="py-1.5 font-medium text-[var(--t3)]">because</th>
              </tr>
            </thead>
            <tbody>
              {[
                'Add some cutaways where he pauses',
                'Put a cutaway at 0:12',
                'This bit is too loud',
                'what is the weather like',
              ].map((p) => {
                const r = route(p);
                return (
                  <tr key={p} className="border-b border-[var(--edge)] align-top">
                    <td className="py-2 pr-3 text-[var(--t1)]">{p}</td>
                    <td className="py-2 pr-3 font-mono text-[12px]" style={{ color: r.plan ? 'var(--t1)' : 'var(--t3)' }}>
                      {r.plan?.cardId ?? 'declined'}
                    </td>
                    <td className="py-2 pr-3 font-mono tabular-nums text-[var(--t2)]">{r.plan?.rung ?? '-'}</td>
                    <td className="py-2 text-[var(--t3)]">{r.plan?.rationale ?? r.declined}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </main>
  );
}

/**
 * A way in.
 *
 * Two of these and nothing else at the top of the page: whatever else this
 * page reports on, someone arriving at the root is looking for the app.
 */
function Door({
  href, title, blurb, accent, icon,
}: {
  href: string;
  title: string;
  blurb: string;
  accent: string;
  icon: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="group flex items-start gap-3 rounded-sm border border-[var(--edge-soft)] bg-[var(--panel)] p-4 no-underline transition-colors hover:border-[var(--t3)] hover:bg-[var(--panel-2)]"
      style={{ boxShadow: 'var(--lift)' }}
    >
      <span
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm"
        style={{ color: accent, border: `1px solid ${accent}`, opacity: 0.9 }}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-2">
          <span className="text-[14px] font-semibold text-[var(--t1)]">{title}</span>
          <span className="font-mono text-[11px] text-[var(--t3)]">{href}</span>
        </span>
        <span className="mt-1 block text-[12.5px] leading-relaxed text-[var(--t2)]">{blurb}</span>
      </span>
    </a>
  );
}

const EditorIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="M7 5v14M17 5v14M2.5 12h4.5M17 12h4.5" />
  </svg>
);

const WorkbenchIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="6" cy="7" r="2.4" /><circle cx="18" cy="17" r="2.4" />
    <path d="M8.4 7H15a2.6 2.6 0 012.6 2.6v5M15.6 17H9a2.6 2.6 0 01-2.6-2.6v-5" />
  </svg>
);

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="mb-10 border-t border-[var(--edge-soft)] pt-5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <p className="mb-3.5 font-mono text-[11px] tracking-wide text-[var(--t3)]">{note}</p>
      {children}
    </section>
  );
}

function Stats({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-5 gap-y-1.5 text-[12.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--t3)]">{k}</dt>
          <dd className="m-0 font-mono tabular-nums text-[var(--t1)]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Verdict({ label, issues }: { label: string; issues: { code: string; message: string }[] }) {
  const clean = issues.length === 0;
  return (
    <div className="mb-2 rounded-sm border border-[var(--edge-soft)] bg-[var(--panel)] p-3" style={{ boxShadow: 'var(--lift)' }}>
      <div className="flex items-center gap-2.5">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: clean ? 'var(--green)' : 'var(--red)' }}
        />
        <span className="text-[12.5px] font-medium">{label}</span>
        <span className="ml-auto font-mono text-[11px] text-[var(--t3)]">
          {clean ? 'compiles' : `${issues.length} issue${issues.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {issues.map((d, i) => (
        <p key={i} className="mt-2 mb-0 border-l-2 border-[var(--red)] pl-2.5 text-[12px] leading-relaxed text-[var(--t2)]">
          <span className="font-mono text-[var(--red)]">{d.code}</span>: {d.message}
        </p>
      ))}
    </div>
  );
}
