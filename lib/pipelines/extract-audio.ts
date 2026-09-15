/**
 * Pull the audio track out of a video.
 *
 * One definition, imported by the workbench and by `npm run pipeline`, so the
 * graph shown in the Pipelines tab is the same graph that was put on the
 * account. Two copies of a graph is two graphs the moment one is edited.
 */
import { GraphBuilder, type Graph } from '../editor-api/graph.ts';

export const EXTRACT_AUDIO_NAME = 'kalash workbench test';

export const EXTRACT_AUDIO_DESCRIPTION =
  'Pull the audio track out of a video, as a 48kHz stereo wav.';

export function extractAudioGraph(): Graph {
  const b = new GraphBuilder();
  const src = b.input('video', 'file:video');
  const audio = b.op('ffmpeg', 'extract-audio', {
    // wav rather than aac: this exists to be fed to something else, and a
    // lossless intermediate does not stack a generation of loss on whatever
    // reads it next
    codec: 'wav',
    sampleRate: '48000',
    channels: '2',
  });
  const out = b.output(['audio']);
  b.wire(src, 'value', audio, 'input').wire(audio, 'file', out, 'audio');
  return b.build();
}
