import { OAUTH_STATE, callbackChannel } from './oauth.js';

const state = new URL(location.href).searchParams.get('state');
if (state && OAUTH_STATE.test(state)) {
  const channel = new BroadcastChannel(callbackChannel(state));
  channel.postMessage({ type: 'gitea-oauth-callback', url: location.href });
  channel.close();
  history.replaceState(null, '', location.pathname);
  document.body.textContent = 'Sign-in complete. You can close this tab.';
  // The opener's popup.close() does not always reach this window; close it from here.
  if (window.top === window) window.close();
} else {
  history.replaceState(null, '', location.pathname);
  document.body.textContent = 'Return to the editor and start sign-in again.';
}
