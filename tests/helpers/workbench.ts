// Workbench mode of browser-test installs. Default: the cached pinned archive (offline).
// BROWSER_WORKBENCH=cdn (opt-in, needs internet): Microsoft's CDN, with Gitea [cors] as README requires.
// @ts-ignore untyped .mjs module
import { cachedWorkbench } from '../../scripts/cached-workbench.mjs';

const cdn = process.env.BROWSER_WORKBENCH === 'cdn';

export const browserWorkbench: { workbench: string; workbenchArchive?: string } = cdn ? { workbench: 'cdn' } : cachedWorkbench();

/** app.ini additions the workbench mode needs. */
export const browserGiteaIni: string | undefined = cdn ? `[cors]
ENABLED = true
ALLOW_DOMAIN = https://*.vscode-cdn.net
METHODS = GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS
HEADERS = Content-Type,User-Agent,Authorization
ALLOW_CREDENTIALS = false
` : undefined;
