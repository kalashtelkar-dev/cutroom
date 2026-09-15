/**
 * Server-sent events, parsed properly.
 *
 * A run stream is the only way progress reaches the UI, so this parser is
 * written against the three things that break naive ones:
 *
 *  1. **An event split across chunk boundaries.** `text/event-stream` is a
 *     byte stream, not a message stream. A chunk can end halfway through
 *     `data: {"pct":` and the rest arrives 40ms later. Anything that does
 *     `chunk.split('\n\n')` loses that event, and it is always the `done`
 *     one because that is the biggest.
 *  2. **CRLF split across the boundary.** The spec allows CR, LF and CRLF as
 *     line terminators, so a chunk ending in a lone `\r` is ambiguous until
 *     the next chunk arrives. Treating it as a terminator inserts a phantom
 *     blank line and dispatches the event early, with half its data.
 *  3. **A final event with no trailing blank line.** The spec says to discard
 *     it; a server that closes cleanly after its last `data:` line means it,
 *     and dropping the terminal `done` event hangs the run forever. We
 *     dispatch what is buffered at EOF instead.
 *
 * The decoder is a class rather than a generator so the chunking behaviour
 * can be tested synchronously, one `push()` at a time.
 */

export interface SseEvent {
  /** The `event:` field. Absent means the default, `message`. */
  event?: string;
  /** `data:` lines joined with '\n', with no trailing newline. */
  data: string;
  /** The last event id seen, which persists across events per the spec. */
  id?: string;
  /** Reconnection hint, in milliseconds. */
  retry?: number;
}

/** Anything a run stream can arrive as: a Response, a stream, an iterable. */
export type SseSource =
  | ReadableStream<Uint8Array>
  | { body: ReadableStream<Uint8Array> | null }
  | AsyncIterable<Uint8Array | string>;

export class SseDecoder {
  private buf = '';
  private data: string[] = [];
  private eventName = '';
  private lastId = '';
  private retry: number | undefined;
  private started = false;

  /** Feed a chunk of decoded text; get back whatever events completed. */
  push(chunk: string): SseEvent[] {
    if (!this.started) {
      this.started = true;
      // Only the very first character of the stream can be a BOM. TextDecoder
      // strips it for byte input; a string source has not been through one.
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    this.buf += chunk;
    const out: SseEvent[] = [];
    for (const line of this.takeLines(false)) this.field(line, out);
    return out;
  }

  /**
   * End of stream. Emits a trailing event that never got its blank line,
   * which is the difference between a run that completes and one that hangs.
   */
  flush(): SseEvent[] {
    const out: SseEvent[] = [];
    for (const line of this.takeLines(true)) this.field(line, out);
    if (this.buf) {
      this.field(this.buf, out);
      this.buf = '';
    }
    this.dispatch(out);
    return out;
  }

  /**
   * Split off complete lines, holding back a trailing lone CR until we know
   * whether an LF follows it in the next chunk.
   */
  private takeLines(final: boolean): string[] {
    const lines: string[] = [];
    let start = 0;
    let i = 0;
    while (i < this.buf.length) {
      const c = this.buf.charCodeAt(i);
      if (c === 10) {
        lines.push(this.buf.slice(start, i));
        i += 1;
        start = i;
      } else if (c === 13) {
        if (i === this.buf.length - 1 && !final) break; // may be the CR of a CRLF
        lines.push(this.buf.slice(start, i));
        i += this.buf.charCodeAt(i + 1) === 10 ? 2 : 1;
        start = i;
      } else {
        i += 1;
      }
    }
    this.buf = this.buf.slice(start);
    return lines;
  }

  private field(raw: string, out: SseEvent[]): void {
    if (raw === '') {
      this.dispatch(out);
      return;
    }
    // A line starting with ':' is a comment. Servers send bare ':' every few
    // seconds to hold the connection open through proxies; it must not
    // dispatch anything or every keep-alive becomes a phantom event.
    if (raw.charCodeAt(0) === 58) return;

    const colon = raw.indexOf(':');
    const name = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? '' : raw.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1); // exactly one space

    switch (name) {
      case 'data':
        this.data.push(value);
        break;
      case 'event':
        this.eventName = value;
        break;
      case 'id':
        // A NUL in an id is ignored rather than fatal, per the spec.
        if (!value.includes('\0')) this.lastId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break; // unknown fields are ignored
    }
  }

  private dispatch(out: SseEvent[]): void {
    if (this.data.length === 0) {
      // A blank line with no data buffered dispatches nothing but still
      // resets the event type, so a stray `event:` cannot leak onto the next.
      this.eventName = '';
      return;
    }
    const ev: SseEvent = { data: this.data.join('\n') };
    if (this.eventName) ev.event = this.eventName;
    if (this.lastId) ev.id = this.lastId;
    if (this.retry !== undefined) ev.retry = this.retry;
    out.push(ev);
    this.data = [];
    this.eventName = '';
  }
}

/** Normalise the three shapes a stream arrives as into one async iterable. */
async function* chunks(source: SseSource): AsyncGenerator<Uint8Array | string> {
  const inner: unknown =
    source && typeof source === 'object' && 'body' in source
      ? (source as { body: unknown }).body
      : source;
  if (!inner) return;

  const iterable = inner as AsyncIterable<Uint8Array | string>;
  if (typeof iterable[Symbol.asyncIterator] === 'function') {
    yield* iterable;
    return;
  }

  const reader = (inner as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    // Breaking out of a `for await` over parseSse must actually close the
    // socket, or a cancelled run keeps streaming into nothing.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

export async function* parseSse(source: SseSource): AsyncGenerator<SseEvent> {
  const decoder = new SseDecoder();
  const text = new TextDecoder();
  for await (const chunk of chunks(source)) {
    const s = typeof chunk === 'string' ? chunk : text.decode(chunk, { stream: true });
    if (s) for (const ev of decoder.push(s)) yield ev;
  }
  const tail = text.decode(); // a multi-byte character split across the last chunk
  if (tail) for (const ev of decoder.push(tail)) yield ev;
  for (const ev of decoder.flush()) yield ev;
}
