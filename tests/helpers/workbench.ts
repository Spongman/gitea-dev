// Workbench of browser-test installs: the cached pinned archive (offline).
// @ts-ignore untyped .mjs module
import { cachedWorkbench } from '../../scripts/cached-workbench.mjs';

export const browserWorkbench: { workbench: string; workbenchArchive?: string } = cachedWorkbench();
