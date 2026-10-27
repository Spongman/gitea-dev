import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OAUTH_STATE, PopupSignIn, authorizationRequest, callbackChannel, isCallback } from '../packages/editor-host/src/oauth.js';

const site = { origin: 'https://g.example', authorizePath: '/login/oauth/authorize', redirectPath: '/assets/gitea-dev/oauth-callback.html' };
const state = (n: number) => `state-${n}-0123456789abcdef`;
const authorize = (n: number) => `${site.origin}${site.authorizePath}?client_id=c&state=${state(n)}`;
const redirect = (n: number, origin = site.origin) => `${origin}${site.redirectPath}?code=c&state=${state(n)}`;

function broadcast(n: number, url: string) {
  const channel = new BroadcastChannel(callbackChannel(state(n)));
  channel.postMessage({ type: 'gitea-oauth-callback', url });
  channel.close();
}

function popups() {
  const opened: { url: string; closed: boolean }[] = [];
  const open = (url: string) => { const popup = { url, closed: false, close() { popup.closed = true; } }; opened.push(popup); return popup; };
  return { opened, open };
}

describe('authorizationRequest', () => {
  it('accepts only the instance authorize endpoint with a well-formed state', () => {
    assert.equal(authorizationRequest(site, authorize(1)).state, state(1));
    assert.throws(() => authorizationRequest(site, `https://evil.example${site.authorizePath}?state=${state(1)}`), /endpoint/);
    assert.throws(() => authorizationRequest(site, `${site.origin}/other?state=${state(1)}`), /endpoint/);
    assert.throws(() => authorizationRequest(site, `${site.origin}${site.authorizePath}?state=short`), /state/);
    assert.ok(OAUTH_STATE.test(state(1)) && !OAUTH_STATE.test('a'.repeat(129)));
  });
});

describe('isCallback', () => {
  it('matches the redirect page of this state only', () => {
    assert.equal(isCallback(site, redirect(1), state(1)), true);
    assert.equal(isCallback(site, redirect(1), state(2)), false);
    assert.equal(isCallback(site, redirect(1, 'https://evil.example'), state(1)), false);
    assert.equal(isCallback(site, `${site.origin}/elsewhere?state=${state(1)}`, state(1)), false);
  });
});

describe('PopupSignIn', () => {
  it('resolves with the redirect URL and closes the popup', async () => {
    const { opened, open } = popups();
    const flow = new PopupSignIn(site, open);
    const result = flow.signIn(authorize(1));
    assert.equal(flow.pending, true);
    broadcast(1, redirect(2));
    broadcast(1, redirect(1, 'https://evil.example'));
    broadcast(1, redirect(1));
    assert.equal(await result, redirect(1));
    assert.equal(opened[0].closed, true);
    assert.equal(flow.pending, false);
  });

  it('lets a new sign-in replace one whose popup was closed without finishing', async () => {
    const { opened, open } = popups();
    const flow = new PopupSignIn(site, open);
    const abandoned = flow.signIn(authorize(1));
    const abandonedOutcome = assert.rejects(abandoned, /cancel/i);
    const second = flow.signIn(authorize(2));
    await abandonedOutcome;
    assert.equal(opened.length, 2);
    assert.equal(opened[0].closed, true);
    broadcast(1, redirect(1));
    broadcast(2, redirect(2));
    assert.equal(await second, redirect(2));
    assert.equal(flow.pending, false);
  });

  it('expires, closes the popup and accepts a new sign-in', async () => {
    const { opened, open } = popups();
    const flow = new PopupSignIn(site, open, 20);
    await assert.rejects(flow.signIn(authorize(1)), /expired/);
    assert.equal(opened[0].closed, true);
    assert.equal(flow.pending, false);
    const next = flow.signIn(authorize(2));
    broadcast(2, redirect(2));
    assert.equal(await next, redirect(2));
  });

  it('reports a blocked popup and an invalid request without staying pending', async () => {
    const flow = new PopupSignIn(site, () => null);
    await assert.rejects(flow.signIn(authorize(1)), /Allow the sign-in popup/);
    assert.equal(flow.pending, false);
    const { opened, open } = popups();
    await assert.rejects(new PopupSignIn(site, open).signIn('https://evil.example/x'), /endpoint/);
    assert.equal(opened.length, 0);
  });
});
