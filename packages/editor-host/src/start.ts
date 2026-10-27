// Start page: Gitea serves static files without isolation headers, so the editor runs only
// under coi-sw.js, which adds them. Registers it, reloads once, and refuses to start otherwise.
import { COLOR_SCHEME_GLOBAL, CONFIGURATION_GLOBAL, workbenchPreloads, workbenchRoot, type DeploymentConfiguration } from './deployment.js';
import { startupColorScheme } from './theme.js';

const RELOAD_KEY = 'gitea-dev:isolation-reload';
const base = new URL('./', import.meta.url);
const stop = (message: string) => { document.body.textContent = message; };

async function start() {
  if (crossOriginIsolated) {
    sessionStorage.removeItem(RELOAD_KEY);
    const response = await fetch(new URL('configuration.json', base), { cache: 'no-cache', credentials: 'same-origin' });
    if (!response.ok) return stop('The Web IDE is not configured. Run its installer.');
    const config: DeploymentConfiguration = await response.json();
    if (!/^[A-Za-z0-9._-]+$/.test(config.version)) return stop('The Web IDE configuration is invalid.');
    // The theme request goes out before the workbench loads: Firefox did not send it within its timeout
    // when it was made as the workbench bundle started to evaluate.
    Object.assign(globalThis, { [COLOR_SCHEME_GLOBAL]: startupColorScheme(config.instance, globalThis.localStorage) });
    const version = new URL(`${config.version}/`, base);
    const root = workbenchRoot(version, config);
    for (const href of [new URL('out/vs/workbench/workbench.web.main.internal.css', root), new URL('host.css', version)]) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href.href;
      document.head.append(link);
    }
    // The 20 MB workbench bundle downloads while bootstrap.js loads and evaluates.
    for (const href of workbenchPreloads(root)) {
      const link = document.createElement('link');
      link.rel = 'modulepreload';
      link.href = href;
      document.head.append(link);
    }
    Object.assign(globalThis, { [CONFIGURATION_GLOBAL]: config });
    await import(new URL('bootstrap.js', version).href);
    return;
  }
  const unsupported = 'The Web IDE needs service workers, which this browser or window does not allow.';
  if (!('serviceWorker' in navigator)) return stop(unsupported);
  if (sessionStorage.getItem(RELOAD_KEY)) {
    sessionStorage.removeItem(RELOAD_KEY);
    return stop('The Web IDE needs cross-origin isolation, which this browser did not enable. Reload to try again.');
  }
  try {
    await navigator.serviceWorker.register(new URL('coi-sw.js', base), { scope: base.pathname });
    await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(reject, 15_000))]);
  } catch { return stop(unsupported); }
  sessionStorage.setItem(RELOAD_KEY, '1');
  location.reload();
}

start().catch(error => stop(error?.name === 'LaunchError' ? `Invalid editor link: ${error.message}.` : 'The Web IDE failed to start.'));
