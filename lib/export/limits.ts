/**
 * Encoder limits derived from the live catalogue schema.
 *
 * Reads parameter schemas from ffmpeg nodes so export bounds (width, height,
 * and containers) reflect the real encoder limits rather than hardcoded guesses.
 */
import { getNode } from '../editor-api/catalogue.ts';

interface SchemaProperty {
  minimum?: number;
  maximum?: number;
  enum?: string[];
}

export interface EncoderLimits {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  containers: readonly ('mp4' | 'mov' | 'webm')[];
}

export function getEncoderLimits(): EncoderLimits {
  const compose = getNode('ffmpeg/compose');
  const crop = getNode('ffmpeg/crop');
  const props = (compose?.params?.properties ?? crop?.params?.properties ?? {}) as Record<string, SchemaProperty>;
  return {
    minWidth: props.width?.minimum ?? 16,
    maxWidth: props.width?.maximum ?? 7680,
    minHeight: props.height?.minimum ?? 16,
    maxHeight: props.height?.maximum ?? 4320,
    containers: (props.container?.enum ?? ['mp4', 'mov', 'webm']) as readonly ('mp4' | 'mov' | 'webm')[],
  };
}

