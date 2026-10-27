// Follows the signed-in user's Gitea theme as light, dark or auto (OS). Gitea marks every page
// with it: <html data-theme="gitea-dark">. Only workbench defaults are set, so a user's own
// color theme setting still wins and is not written to settings.json.
export type ColorScheme = 'light' | 'dark' | 'auto';

const CACHE_KEY = 'gitea-dev:color-scheme';
const THEME_ATTRIBUTE = /<html\b[^>]*\bdata-theme="([^"]*)"/i;
const MAX_SCAN = 64 * 1024;
// `-/` is reserved by Gitea, so no user or organization owns the path.
const PROBE_PATH = '-/gitea-dev-theme-probe';

export function colorSchemeOf(theme: string | undefined): ColorScheme {
  const name = (theme ?? '').toLowerCase();
  if (name.includes('dark')) return 'dark';
  if (name.includes('light')) return 'light';
  return 'auto';
}

export function themeDefaults(scheme: ColorScheme): Record<string, unknown> {
  if (scheme === 'dark') return { 'workbench.colorTheme': 'Dark 2026' };
  if (scheme === 'light') return { 'workbench.colorTheme': 'Light 2026' };
  return { 'window.autoDetectColorScheme': true };
}

/**
 * Reads the theme from a page that renders only the base template, scanning only up to the <html>
 * tag: the 404 page of a reserved path (the dashboard is several times costlier to render). Gitea
 * answers that page with HTML only when asked for HTML.
 */
export async function giteaTheme(instance: string, fetchImpl: typeof fetch = fetch, timeoutMs = 1500): Promise<string | undefined> {
  const response = await fetchImpl(new URL(PROBE_PATH, instance.endsWith('/') ? instance : `${instance}/`).href, {
    credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!(response.ok || response.status === 404) || !response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < MAX_SCAN) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const match = THEME_ATTRIBUTE.exec(text);
      if (match) return match[1];
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return undefined;
}

const CONFIRMED_KEY = 'gitea-dev:color-scheme-confirmed';

function asScheme(value: unknown): ColorScheme | undefined {
  return value === 'light' || value === 'dark' || value === 'auto' ? value : undefined;
}

/**
 * Records the scheme of the user's Gitea theme setting as read from the API after sign-in, when it
 * disagreed with the page. It then wins over the page on later loads.
 */
export function rememberConfirmedScheme(storage: Pick<Storage, 'setItem'> | undefined, scheme: unknown): boolean {
  const valid = asScheme(scheme);
  if (valid === undefined) return false;
  storage?.setItem(CONFIRMED_KEY, valid);
  return true;
}

/** The scheme to start with: an API-confirmed scheme, else the live Gitea theme, else the last one seen, else auto. */
export async function startupColorScheme(instance: string, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, fetchImpl?: typeof fetch): Promise<ColorScheme> {
  const confirmed = asScheme(storage?.getItem(CONFIRMED_KEY));
  if (confirmed !== undefined) return confirmed;
  try {
    const theme = await giteaTheme(instance, fetchImpl);
    if (theme !== undefined) {
      const scheme = colorSchemeOf(theme);
      storage?.setItem(CACHE_KEY, scheme);
      return scheme;
    }
  } catch { /* offline, slow or blocked: fall back */ }
  return asScheme(storage?.getItem(CACHE_KEY)) ?? 'auto';
}
