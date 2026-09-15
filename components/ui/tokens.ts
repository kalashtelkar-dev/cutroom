/**
 * Resolve a design token to a real colour.
 *
 * Canvas cannot read a CSS custom property: `fillStyle = 'var(--orange)'` is
 * silently ignored and you get black. Anything painting pixels has to resolve
 * the token itself, and anything storing a colour in the document (a marker,
 * say) has to store the resolved value rather than the token name.
 *
 * The fallbacks exist for server rendering, where there is no document to read
 * from. They are the same values as app/globals.css and must be kept in step
 * with it; the house-rules test allows them for exactly this reason.
 *
 * "Must be kept in step" is not a promise anyone can keep by hand, so
 * test/shell-ui.test.ts parses the `:root` block of app/globals.css and fails
 * on the first key that has drifted.
 */
export const FALLBACKS: Record<string, string> = {
  '--app': '#000000',
  '--tl': '#050505',
  '--panel': '#0a0a0a',
  '--panel-2': '#101010',
  '--head': '#121212',
  '--edge': '#1e1e1e',
  '--edge-soft': '#2a2a2a',
  '--lane-v': '#0c0c0c',
  '--lane-a': '#080808',
  '--ruler': '#0d0d0d',
  '--clip-v': '#1a1a1a',
  '--clip-v-bar': '#262626',
  '--clip-b': '#211a1f',
  '--clip-b-bar': '#33262e',
  '--clip-a': '#141414',
  '--clip-a-bar': '#202020',
  '--clip-edge': '#2a2a2a',
  '--wave': '#3b74e0',
  '--orange': '#ed1b1b',
  '--red': '#ff4a4a',
  '--yellow': '#e0a82e',
  '--green': '#35b96a',
  '--blue': '#2f6fe8',
  '--t1': '#ededed',
  '--t2': '#8f8f8f',
  '--t3': '#5c5c5c',
  '--mono': '"IBM Plex Mono", ui-monospace, Menlo, monospace',
};

export function readToken(name: string, fallback?: string): string {
  const fb = fallback ?? FALLBACKS[name] ?? '#000000';
  if (typeof window === 'undefined') return fb;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

/**
 * A reader bound to one computed-style read.
 *
 * getComputedStyle forces a style recalculation, so a painter that resolves
 * ten tokens per frame should take one of these at the top of the paint and
 * call it, rather than calling readToken ten times.
 */
export type TokenReader = (name: string, fallback?: string) => string;

export function tokenReader(): TokenReader {
  if (typeof window === 'undefined') return (n, f) => f ?? FALLBACKS[n] ?? '#000000';
  const css = getComputedStyle(document.documentElement);
  return (name, fallback) =>
    css.getPropertyValue(name).trim() || fallback || FALLBACKS[name] || '#000000';
}
