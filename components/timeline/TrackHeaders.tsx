'use client';
/**
 * The track header column.
 *
 * Alignment is the whole job. Header row N must begin on the same pixel as
 * lane N or the column is useless, and there are two ways to get that wrong:
 *
 *  - putting anything above the headers that is not exactly as tall as the
 *    ruler. The spacer here is `RULER_HEIGHT` and nothing else lives in that
 *    corner; add-track buttons went to the toolbar for precisely this reason.
 *  - scrolling the two columns independently. They are inside ONE scroller
 *    and this column is `position: sticky; left: 0`, so vertical scroll is
 *    shared by construction and horizontal scroll is pinned by the
 *    compositor, no scroll handler copying `scrollTop` a frame late.
 *
 * Each row's height comes from the same `LaneBox` the lane is drawn from, so
 * the two cannot disagree.
 */
import { useState } from 'react';
import type { EditOp, Track, TrackId, TrackKind } from '../../lib/timeline/types.ts';
import type { LaneBox } from './interactions.ts';
import { RULER_HEIGHT } from './Ruler.tsx';

export interface TrackHeadersProps {
  tracks: readonly Track[];
  boxes: readonly LaneBox[];
  /** How many clips are on each track, for the count badge. */
  counts: Record<TrackId, number>;
  width: number;
  /** The destination track: where an insert or paste lands. */
  destination: TrackId | null;
  onDestination: (id: TrackId) => void;
  onEdit: (ops: EditOp[], label: string) => void;
  /** Delete a track, clips and all. One undo puts it back. */
  onRemoveTrack: (track: Track) => void;
  /** Add a new track of the specified kind. */
  onAddTrack?: (kind: TrackKind) => void;
}

const STRIPE: Record<Track['kind'], string> = {
  video: 'var(--blue)',
  audio: 'var(--yellow)',
  subtitle: 'var(--green)',
};

export function TrackHeaders({
  tracks, boxes, counts, width, destination, onDestination, onEdit,
  onRemoveTrack, onAddTrack,
}: TrackHeadersProps) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const patch = (track: Track, set: Partial<Track>, label: string) =>
    onEdit([{ op: 'patch_track', trackId: track.id, set }], label);

  return (
    <>
    <style href="cutroom-track-headers" precedence="medium">{TRACK_CSS}</style>
    <div
      style={{
        position: 'sticky',
        left: 0,
        zIndex: 8, // above the playhead, which must slide under this column
        width,
        flex: 'none',
        background: 'var(--panel)',
      }}
    >
      {/* exactly as tall as the ruler, this is what keeps row N on lane N */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 9,
          height: RULER_HEIGHT,
          background: 'var(--ruler)',
          borderBottom: '1px solid var(--edge)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 6px',
        }}
      >
        <span style={{ fontSize: 9.5, fontFamily: 'var(--mono)', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Tracks
        </span>
        {onAddTrack ? (
          <div style={{ position: 'relative' }}>
            {/*
              Red, like Export.

              It is the one control in this column that adds something rather
              than changing what is already there, and it sat as a hairline
              outline in the quietest corner of the chrome. Red is this
              application's action colour, and an action is what this is.
            */}
            <button
              type="button"
              onClick={() => setAddMenuOpen((o) => !o)}
              title="Add track: Video, Audio, or Subtitle"
              aria-label="Add track"
              aria-expanded={addMenuOpen}
              style={{
                background: 'var(--red)',
                border: '1px solid var(--red)',
                borderRadius: 3,
                color: 'var(--on-accent)',
                fontSize: 9.5,
                fontWeight: 600,
                fontFamily: 'var(--mono)',
                padding: '0 5px',
                height: 17,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                // open is a state the button has to show: the menu it opens
                // is over the lanes, not over this
                filter: addMenuOpen ? 'brightness(1.15)' : undefined,
              }}
            >
              <span style={{ fontSize: 11, lineHeight: 1 }}>+</span>
              <span>Track</span>
            </button>
            {addMenuOpen ? (
              <div
                className="cr-ctx"
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 2,
                  zIndex: 20,
                  minWidth: 135,
                }}
              >
                <button
                  type="button"
                  className="cr-ctx-item"
                  onClick={() => { setAddMenuOpen(false); onAddTrack('video'); }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)' }} />
                  <span>Video track</span>
                </button>
                <button
                  type="button"
                  className="cr-ctx-item"
                  onClick={() => { setAddMenuOpen(false); onAddTrack('audio'); }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--yellow)' }} />
                  <span>Audio track</span>
                </button>
                <button
                  type="button"
                  className="cr-ctx-item"
                  onClick={() => { setAddMenuOpen(false); onAddTrack('subtitle'); }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)' }} />
                  <span>Subtitle track</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div role="list" aria-label="Tracks">
        {tracks.map((track, i) => {
          const box = boxes[i];
          const isAudio = track.kind === 'audio';
          const active = destination === track.id;
          const clipsOn = counts[track.id] ?? 0;
          return (
            <div
              role="listitem"
              key={track.id}
              style={{
                height: box.height,
                display: 'flex',
                alignItems: 'stretch',
                borderBottom: '1px solid var(--edge)',
                background: active ? 'var(--panel-2)' : 'var(--panel)',
              }}
            >
              <span aria-hidden style={{ width: 4, flex: 'none', background: STRIPE[track.kind] }} />
              <div
                style={{
                  flex: 1,
                  padding: '5px 6px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  minWidth: 0,
                  justifyContent: 'center',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <button
                    type="button"
                    onClick={() => onDestination(track.id)}
                    aria-pressed={active}
                    title="Destination track, inserts and pastes land here"
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 10.5,
                      fontWeight: 600,
                      padding: '1px 5px',
                      borderRadius: 4,
                      border: 0,
                      cursor: 'pointer',
                      flex: 'none',
                      background: active ? 'var(--orange)' : 'var(--ctl-off)',
                      color: active ? 'var(--t1)' : 'var(--app)',
                    }}
                  >
                    {shortName(track)}
                  </button>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 11,
                      color: 'var(--t2)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                    }}
                  >
                    {track.name}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', flex: 'none' }}>
                    {clipsOn}
                  </span>
                </div>

                {box.height >= 36 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <Toggle
                      on={track.locked}
                      label={`Lock ${track.name}`}
                      hint="Nothing on a locked track can be moved, trimmed or rippled."
                      onClick={() => patch(track, { locked: !track.locked }, 'Lock track')}
                    >
                      <LockIcon />
                    </Toggle>

                    {isAudio ? (
                      <>
                        <Toggle
                          on={track.muted}
                          tone="var(--red)"
                          label={`Mute ${track.name}`}
                          hint="Silences this track in monitoring and on output."
                          onClick={() => patch(track, { muted: !track.muted }, 'Mute track')}
                        >
                          M
                        </Toggle>
                        <Toggle
                          on={track.solo}
                          tone="var(--yellow)"
                          label={`Solo ${track.name}`}
                          hint="Hear only the soloed tracks."
                          onClick={() => patch(track, { solo: !track.solo }, 'Solo track')}
                        >
                          S
                        </Toggle>
                      </>
                    ) : (
                      <Toggle
                        on={track.enabled}
                        label={`Enable ${track.name}`}
                        hint="Off keeps the track in the timeline but out of the picture."
                        onClick={() => patch(track, { enabled: !track.enabled }, 'Enable track')}
                      >
                        <EyeIcon />
                      </Toggle>
                    )}

                    <Toggle
                      on={track.autoSelect}
                      label={`Auto select ${track.name}`}
                      hint="Ripples and inserts skip this track while it is off. This is how you protect music under a re-cut."
                      onClick={() => patch(track, { autoSelect: !track.autoSelect }, 'Auto select')}
                    >
                      A
                    </Toggle>

                    <span style={{ flex: 1 }} />

                    <button
                      type="button"
                      className="cr-trkdel"
                      aria-label={`Delete ${track.name}`}
                      title={
                        clipsOn > 0
                          ? `Delete ${track.name} and the ${clipsOn} clip${clipsOn === 1 ? '' : 's'} on it. Undo puts them back.`
                          : `Delete ${track.name}`
                      }
                      onClick={() => onRemoveTrack(track)}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
    </>
  );
}

const TRACK_CSS = `
.cr-trkdel{
  width:15px;height:15px;flex:none;display:flex;align-items:center;justify-content:center;
  border:0;background:none;padding:0;cursor:pointer;color:var(--t3);border-radius:3px;
  opacity:0;transition:opacity .12s,color .12s;
}
/* shown on hover or focus only: a delete that is always visible beside a
   lock and a mute gets pressed by accident */
[role="listitem"]:hover .cr-trkdel,.cr-trkdel:focus-visible{opacity:1}
.cr-trkdel:hover{color:var(--red);background:var(--panel-2)}
`;

const TrashIcon = () => (
  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor"
    strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 4h11M6.5 4V2.6h3V4M4 4l.7 9.4h6.6L12 4M6.6 6.6v4.4M9.4 6.6v4.4" />
  </svg>
);

/** `trk_v1` reads as V1 in the badge, the id is the editor-API's, not the user's. */
function shortName(track: Track): string {
  const tail = track.id.split('_').pop() ?? track.id;
  return tail.toUpperCase().slice(0, 3);
}

function Toggle({
  on, onClick, label, hint, tone = 'var(--ctl-on)', children,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  hint: string;
  tone?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
      title={`${label}, ${hint}`}
      style={{
        width: 17,
        height: 15,
        borderRadius: 4,
        border: 0,
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flex: 'none',
        fontSize: 8.5,
        fontWeight: 700,
        lineHeight: 1,
        color: on ? tone : 'var(--ctl-off)',
      }}
    >
      {children}
    </button>
  );
}

const svgProps = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  width: 10,
  height: 10,
  'aria-hidden': true,
} as const;

const LockIcon = () => (
  <svg {...svgProps}>
    <rect x="3.5" y="7" width="9" height="6" rx="1" />
    <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
  </svg>
);

const EyeIcon = () => (
  <svg {...svgProps}>
    <path d="M1.5 8S4 4 8 4s6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" />
    <circle cx="8" cy="8" r="1.8" />
  </svg>
);
