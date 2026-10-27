/** `configuration.json`, written by scripts/install.sh. */
export interface DeploymentConfiguration {
  /** Gitea ROOT_URL without a trailing slash. */
  instance: string;
  /** Versioned directory holding the workbench, extension and host bundle. */
  version: string;
  oauthClientId: string | null;
  /** Gallery root without a trailing slash; null disables the gallery. */
  gallery: string | null;
  /** Lowercase `publisher.name` ids; null allows every gallery extension. */
  extensionsAllowlist: string[] | null;
  /** Extra extension-host connect-src sources, space-separated. */
  connectSrc: string;
  webviews: 'disabled' | 'vscode-cdn';
  /** Workbench root on Microsoft's CDN (`https://main.vscode-cdn.net/<quality>/<commit>/`); null for `<version>/workbench/`. */
  workbench: string | null;
  testMode: boolean;
}

export const CONFIGURATION_GLOBAL = '__giteaDevConfiguration';
/** The startup color scheme promise (theme.ts `startupColorScheme`), set by start.ts. */
export const COLOR_SCHEME_GLOBAL = '__giteaDevColorScheme';

/** The workbench modules bootstrap.ts imports in this order, relative to the workbench root. */
export const WORKBENCH_NLS = 'out/nls.messages.js';
export const WORKBENCH_MAIN = 'out/vs/workbench/workbench.web.main.internal.js';

/** The workbench root for a version directory URL (`<instance assets>/<version>/`). */
export const workbenchRoot = (version: URL, config: Pick<DeploymentConfiguration, 'workbench'>) => new URL(config.workbench ?? 'workbench/', version);

/** Absolute URLs of those modules for a workbench root. */
export const workbenchPreloads = (root: URL) => [WORKBENCH_NLS, WORKBENCH_MAIN].map(path => new URL(path, root).href);
