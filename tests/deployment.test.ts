import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WORKBENCH_MAIN, WORKBENCH_NLS, workbenchPreloads, workbenchRoot } from '../packages/editor-host/src/deployment.js';

describe('workbenchPreloads', () => {
  it('names the modules bootstrap imports, below the installed workbench of the version directory', () => {
    const root = workbenchRoot(new URL('https://g.example/sub/assets/gitea-dev/abc-123/'));
    assert.deepEqual(workbenchPreloads(root), [
      'https://g.example/sub/assets/gitea-dev/abc-123/workbench/out/nls.messages.js',
      'https://g.example/sub/assets/gitea-dev/abc-123/workbench/out/vs/workbench/workbench.web.main.internal.js',
    ]);
    assert.ok(workbenchPreloads(root).every(href => href === new URL(href).href));
  });

  it('is what bootstrap imports, in dependency order (NLS messages first)', () => {
    assert.deepEqual(workbenchPreloads(new URL('https://g.example/v/workbench/')).map(href => href.slice('https://g.example/v/workbench/'.length)), [WORKBENCH_NLS, WORKBENCH_MAIN]);
  });
});
