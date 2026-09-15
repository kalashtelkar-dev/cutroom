/**
 * A project to open into.
 *
 * An editor that opens empty shows nothing about what it does, so the app
 * boots with a real cut: seven clips on V1, four cutaways on V2, dialogue,
 * SFX and music. The media keys are the shape AISuite generations actually
 * have; nothing here is fetched.
 *
 * Everything is in frames at 24fps. `available` is deliberately wider than
 * `sourceRange` on most clips, because trim handles are only interesting when
 * there is handle to trim into.
 */
import { RATES, frames, timeRange, type Frames } from '../time/frames.ts';
import type { Clip, MediaRef, Timeline, Track } from '../timeline/types.ts';

const F = (seconds: number): Frames => frames(Math.round(seconds * 24));

interface Seed {
  key: string;
  name: string;
  kind: MediaRef['kind'];
  /** Seconds of source that exist. */
  available: number;
}

const MEDIA: Seed[] = [
  { key: 'gen/redrock_talent_3', name: 'RedRock_Talent_3.mov', kind: 'video', available: 6.5 },
  { key: 'gen/lake_next_to_mountains', name: 'lake_next_to_mountains.mov', kind: 'video', available: 12.1 },
  { key: 'gen/amalfi_coast_aerial_7', name: 'Amalfi_Coast_Aerial_7.mov', kind: 'video', available: 9.2 },
  { key: 'gen/amalfi_coast_aerial_8', name: 'Amalfi_Coast_Aerial_8.mov', kind: 'video', available: 11.4 },
  { key: 'gen/woman_riding_scooter', name: 'woman_riding_scooter.mov', kind: 'video', available: 5.9 },
  { key: 'gen/clip_04_turtle_reef', name: 'Clip-04-turtle-reef.mov', kind: 'video', available: 8.4 },
  { key: 'gen/end_credits_plate', name: 'End_Credits_Plate.mov', kind: 'video', available: 7.0 },
  { key: 'gen/mountains_alone', name: 'mountains_alone_at_dusk.mov', kind: 'video', available: 6.2 },
  { key: 'gen/amalfi_talent_balcony', name: 'Amalfi_Talent_Balcony.mov', kind: 'video', available: 5.4 },
  { key: 'gen/people_running_shore', name: 'people_running_shore.mov', kind: 'video', available: 6.8 },
  { key: 'gen/thick_forest_aerial', name: 'thick_forest_aerial.mov', kind: 'video', available: 9.6 },
  { key: 'gen/ab0102_01', name: 'AB0102_01.wav', kind: 'audio', available: 13.0 },
  { key: 'gen/ab0102_02', name: 'AB0102_02.wav', kind: 'audio', available: 12.0 },
  { key: 'gen/ab0102_03', name: 'AB0102_03.wav', kind: 'audio', available: 11.5 },
  { key: 'gen/sfx_overhead', name: 'SFX-Overhead.wav', kind: 'audio', available: 4.5 },
  { key: 'gen/sfx_distant_prop', name: 'SFX-Distant_prop.wav', kind: 'audio', available: 6.8 },
  { key: 'gen/sound_fx', name: 'SOUND_FX.wav', kind: 'audio', available: 5.2 },
  { key: 'gen/music_score_trailer', name: 'Music_Score_Trailer.mov', kind: 'audio', available: 42.0 },
];

export const DEMO_MEDIA: Record<string, MediaRef> = Object.fromEntries(
  MEDIA.map((m) => [
    m.key,
    { key: m.key, name: m.name, kind: m.kind, available: timeRange(F(0), F(m.available)) },
  ]),
);

/**
 * Ids are derived from the media key rather than a counter, so a failing
 * assertion names the clip it is about instead of `clp_011`.
 *
 * The counters live inside the factory on purpose: as module state they made
 * demoProject() return different ids on a second call, which is exactly the
 * kind of thing that survives every test and then breaks a reset button.
 */
function makeFactories() {
  const used = new Map<string, number>();
  let gapN = 0;
  const clip = (key: string, srcStart: number, duration: number): Clip => {
    const base = key.split('/')[1];
    const seen = (used.get(base) ?? 0) + 1;
    used.set(base, seen);
    return {
      id: `clp_${base}${seen > 1 ? `_${seen}` : ''}`,
      kind: 'clip',
      name: DEMO_MEDIA[key].name,
      mediaKey: key,
      sourceRange: timeRange(F(srcStart), F(duration)),
      enabled: true,
      effects: [],
    };
  };
  const gap = (duration: number) => ({ id: `gap_${++gapN}`, kind: 'gap' as const, duration: F(duration) });
  return { clip, gap };
}

const track = (
  id: string,
  kind: Track['kind'],
  name: string,
  items: Track['items'],
): Track => ({
  id, kind, name, items,
  locked: false, muted: false, solo: false, enabled: true, autoSelect: true,
});

function cutsOn(track: Track): Frames[] {
  const out: Frames[] = [];
  let cursor = 0;
  for (const item of track.items) {
    cursor += item.kind === 'clip' ? item.sourceRange.duration : item.kind === 'gap' ? item.duration : 0;
    out.push(frames(cursor));
  }
  return out;
}

export function demoProject(): Timeline {
  const { clip, gap } = makeFactories();
  const doc: Timeline = {
    id: 'tl_amalfi_summer',
    name: 'Amalfi Coast · Summer Cut',
    rate: RATES.film,
    revision: 7,
    /**
     * A copy, one level deep. Two calls used to hand back the same pool
     * object, so editing a clip's media in one document edited it in every
     * document anyone had made, including the ones a test had already taken a
     * snapshot of. A fixture that is shared by reference is a fixture that
     * reports whatever the last caller did to it.
     */
    media: Object.fromEntries(Object.entries(DEMO_MEDIA).map(([k, m]) => [k, { ...m }])),
    /**
     * Markers land on real cuts, computed below rather than typed in seconds.
     * Frame positions are the SUM of integer durations, which is not the same
     * number as converting the summed seconds, 3.4s + 6.2s is frame 231, but
     * round(9.6 × 24) is 230. Writing a marker in seconds puts it one frame
     * off the cut it is supposed to mark, every time.
     */
    markers: [],
    tracks: [
      // cutaways sit above the A-roll and are mostly gap
      track('trk_v2', 'video', 'Video 2', [
        gap(8.2), clip('gen/mountains_alone', 0.4, 2.6),
        gap(4.0), clip('gen/amalfi_talent_balcony', 0, 2.4),
        gap(6.4), clip('gen/people_running_shore', 1.1, 2.2),
        gap(5.8), clip('gen/thick_forest_aerial', 0, 2.8),
      ]),
      track('trk_v1', 'video', 'Video 1', [
        clip('gen/redrock_talent_3', 0, 3.4),
        clip('gen/lake_next_to_mountains', 1.1, 6.2),
        clip('gen/amalfi_coast_aerial_7', 0, 7.1),
        clip('gen/amalfi_coast_aerial_8', 0.6, 8.3),
        clip('gen/woman_riding_scooter', 0, 3.1),
        clip('gen/clip_04_turtle_reef', 0.4, 5.2),
        clip('gen/end_credits_plate', 0, 4.4),
      ]),
      track('trk_a1', 'audio', 'Dialogue', [
        clip('gen/ab0102_01', 0, 12.2),
        gap(1.8), clip('gen/ab0102_02', 0, 11.0),
        gap(1.4), clip('gen/ab0102_03', 0, 10.8),
      ]),
      track('trk_a2', 'audio', 'SFX', [
        gap(4.2), clip('gen/sfx_overhead', 0, 3.6),
        gap(9.8), clip('gen/sfx_distant_prop', 0, 5.4),
        gap(6.6), clip('gen/sound_fx', 0, 4.2),
      ]),
      track('trk_a3', 'audio', 'Music', [clip('gen/music_score_trailer', 0, 37.7)]),
    ],
  };

  const cuts = cutsOn(doc.tracks[1]);   // V1
  doc.markers = [
    { id: 'mk_act', at: cuts[1], name: 'Act break', colour: 'var(--blue)' },
    { id: 'mk_music', at: cuts[3], name: 'Music hits', colour: 'var(--yellow)' },
    { id: 'mk_outro', at: cuts[5], name: 'Outro', colour: 'var(--green)' },
  ];
  return doc;
}
