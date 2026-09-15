/**
 * Project track templates.
 *
 * An editor project can start from different track layouts depending on delivery:
 * a standard dual-video triple-audio setup, a minimal cut, vertical video with
 * subtitles, or a podcast with separated mics.
 */
import type { Track, TrackKind } from './types.ts';

export interface TrackTemplateItem {
  id: string;
  kind: TrackKind;
  name: string;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  tracks: TrackTemplateItem[];
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'standard',
    name: 'Standard',
    description: 'V2, V1, Dialogue (A1), SFX (A2), Music (A3)',
    tracks: [
      { id: 'trk_v2', kind: 'video', name: 'Video 2' },
      { id: 'trk_v1', kind: 'video', name: 'Video 1' },
      { id: 'trk_a1', kind: 'audio', name: 'Dialogue' },
      { id: 'trk_a2', kind: 'audio', name: 'SFX' },
      { id: 'trk_a3', kind: 'audio', name: 'Music' },
    ],
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Single video and audio track (V1, A1)',
    tracks: [
      { id: 'trk_v1', kind: 'video', name: 'Video 1' },
      { id: 'trk_a1', kind: 'audio', name: 'Audio 1' },
    ],
  },
  {
    id: 'social',
    name: 'Social / Vertical',
    description: 'Subtitles, Video 1, Audio 1',
    tracks: [
      { id: 'trk_s1', kind: 'subtitle', name: 'Subtitles 1' },
      { id: 'trk_v1', kind: 'video', name: 'Video 1' },
      { id: 'trk_a1', kind: 'audio', name: 'Audio 1' },
    ],
  },
  {
    id: 'podcast',
    name: 'Podcast / Multi-mic',
    description: 'Video 1 with 4 audio tracks: Host, Guest 1, Guest 2, Music',
    tracks: [
      { id: 'trk_v1', kind: 'video', name: 'Video 1' },
      { id: 'trk_a1', kind: 'audio', name: 'Host' },
      { id: 'trk_a2', kind: 'audio', name: 'Guest 1' },
      { id: 'trk_a3', kind: 'audio', name: 'Guest 2' },
      { id: 'trk_a4', kind: 'audio', name: 'Music' },
    ],
  },
];

export function getTemplate(templateId?: string): ProjectTemplate {
  const match = PROJECT_TEMPLATES.find((t) => t.id === templateId);
  return match ?? PROJECT_TEMPLATES[0];
}

export function templateTracks(templateId?: string): Track[] {
  const tpl = getTemplate(templateId);
  return tpl.tracks.map((t) => ({
    id: t.id,
    kind: t.kind,
    name: t.name,
    items: [],
    locked: false,
    muted: false,
    solo: false,
    enabled: true,
    autoSelect: true,
  }));
}

