import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WORKBENCH_MAIN, WORKBENCH_NLS, workbenchPreloads, workbenchRoot } from '../packages/editor-host/src/deployment.js';

describe('workbenchPreloads', () => {
  it('names the modules bootstrap imports, below the installed workbench of the version directory', () => {
    const root = workbenchRoot(new URL('https://g.example/sub/assets/gitea-dev/abc-123/'), { workbench: null });
    assert.deepEqual(workbenchPreloads(root), [
      'https://g.example/sub/assets/gitea-dev/abc-123/workbench/out/nls.messages.js',
      'https://g.example/sub/assets/gitea-dev/abc-123/workbench/out/vs/workbench/workbench.web.main.internal.js',
    ]);
    assert.ok(workbenchPreloads(root).every(href => href === new URL(href).href));
  });

  it('loads from the CDN root when configured', () => {
    const cdn = 'https://main.vscode-cdn.net/stable/e646868227c3e3a9e3f24277c8c7220be42c0be7/';
    const root = workbenchRoot(new URL('https://g.example/assets/gitea-dev/abc-123/'), { workbench: cdn });
    assert.deepEqual(workbenchPreloads(root), [`${cdn}out/nls.messages.js`, `${cdn}out/vs/workbench/workbench.web.main.internal.js`]);
  });

  it('is what bootstrap imports, in dependency order (NLS messages first)', () => {
    assert.deepEqual(workbenchPreloads(new URL('https://g.example/v/workbench/')).map(href => href.slice('https://g.example/v/workbench/'.length)), [WORKBENCH_NLS, WORKBENCH_MAIN]);
  });
});
