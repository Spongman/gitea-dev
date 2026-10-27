import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { cspKey, IFRAME, localCsp, localUrl, needsHtml, type CspPolicies } from '../packages/editor-host/src/sw-policy.js';

const PAGE = "default-src 'none'; script-src 'self' blob:; connect-src 'self'";
const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const policies: CspPolicies = {
  page: PAGE,
  iframe: "default-src 'none'; script-src 'self' 'unsafe-eval' blob:; connect-src 'self' https://x",
  scriptHashes: { [IFRAME]: "'sha256-NEWBUILD'", 'workbench/out/other.html': "'sha256-OTHER' 'sha256-TWO'" },
};

describe('localCsp', () => {
  it('adds the installed hashes of the worker\'s own version, and uses the iframe policy for the extension host iframe', async () => {
    assert.equal(await localCsp(`v2/${IFRAME}`, 'v2', policies), "default-src 'none'; script-src 'self' 'sha256-NEWBUILD' 'unsafe-eval' blob:; connect-src 'self' https://x");
    assert.equal(await localCsp('v2/workbench/out/other.html', 'v2', policies), "default-src 'none'; script-src 'self' 'sha256-OTHER' 'sha256-TWO' blob:; connect-src 'self'");
    assert.equal(await localCsp('v2/host.css', 'v2', policies), PAGE);
    assert.equal(await localCsp('index.html', 'v2', policies), PAGE);
  });

  it('never gives a page of another version the hashes of this install', async () => {
    const html = '<html><script>old()</script><script>two()</script></html>';
    const csp = await localCsp(`v1/${IFRAME}`, 'v2', policies, html);
    assert.equal(csp, `default-src 'none'; script-src 'self' ${sha('old()')} ${sha('two()')} 'unsafe-eval' blob:; connect-src 'self' https://x`);
    const plain = await localCsp('v1/workbench/out/new.html', 'v2', policies, '<script>x()</script>');
    assert.equal(plain, `default-src 'none'; script-src 'self' ${sha('x()')} blob:; connect-src 'self'`);
    assert.equal(await localCsp('v1/workbench/out/other.html', 'v2', policies, '<p>none</p>'), PAGE);
  });

  it('reads the body only for HTML of another version', () => {
    assert.equal(needsHtml(`v1/${IFRAME}`, 'v2'), true);
    assert.equal(needsHtml(`v2/${IFRAME}`, 'v2'), false);
    assert.equal(needsHtml('v1/host.css', 'v2'), false);
    assert.equal(needsHtml('index.html', 'v2'), false);
  });

  it('keys hashes below the version directory', () => {
    assert.equal(cspKey('v1/workbench/a.html'), 'workbench/a.html');
    assert.equal(cspKey('index.html'), 'index.html');
  });
});

describe('localUrl', () => {
  it('drops the OAuth code and state before the callback page is fetched from Gitea', () => {
    const url = new URL('https://g.example/assets/gitea-dev/oauth-callback.html?code=SECRET&state=abc#frag');
    assert.equal(localUrl(url, 'oauth-callback.html').href, 'https://g.example/assets/gitea-dev/oauth-callback.html');
  });

  it('leaves other files alone', () => {
    const url = new URL('https://g.example/assets/gitea-dev/index.html?owner=a&repository=b');
    assert.equal(localUrl(url, 'index.html'), url);
  });
});
