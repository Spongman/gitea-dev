// OAuth popup sign-in, shared by bootstrap.ts (opener) and oauth-callback.ts (redirect target).
// The callback page broadcasts its URL on a channel named after the request's `state`.

export const OAUTH_STATE = /^[A-Za-z0-9_-]{16,128}$/;
export const callbackChannel = (state: string) => `gitea-oauth:${state}`;

export interface OAuthSite {
  origin: string;
  /** Path of Gitea's authorize endpoint. */
  authorizePath: string;
  /** Path of the redirect page. */
  redirectPath: string;
}

export function authorizationRequest(site: OAuthSite, authorizationUrl: string) {
  const url = new URL(authorizationUrl);
  if (url.origin !== site.origin || url.pathname !== site.authorizePath) throw new Error('Invalid authorization endpoint.');
  const state = url.searchParams.get('state');
  if (!state || !OAUTH_STATE.test(state)) throw new Error('Invalid authorization state.');
  return { url, state };
}

/** Whether `href` is the redirect page answering the request for `state`. */
export function isCallback(site: OAuthSite, href: string, state: string): boolean {
  const url = new URL(href);
  return url.origin === site.origin && url.pathname === site.redirectPath && url.searchParams.get('state') === state;
}

interface Popup { close(): void }

export class PopupSignIn {
  private cancel?: (reason: Error) => void;

  constructor(
    private readonly site: OAuthSite,
    private readonly open: (url: string) => Popup | null,
    private readonly timeoutMs = 10 * 60_000,
  ) {}

  get pending() { return this.cancel !== undefined; }

  /** Resolves with the redirect URL. A newer sign-in cancels a pending one, whose popup may be gone. */
  async signIn(authorizationUrl: string): Promise<string> {
    const { url, state } = authorizationRequest(this.site, authorizationUrl);
    this.cancel?.(new Error('Sign-in cancelled by a newer attempt.'));
    const popup = this.open(url.href);
    if (!popup) throw new Error('Allow the sign-in popup and try again.');
    return new Promise<string>((resolve, reject) => {
      const channel = new BroadcastChannel(callbackChannel(state));
      const timer = setTimeout(() => finish(new Error('Sign-in expired.')), this.timeoutMs);
      const finish = (error?: Error, value?: string) => {
        clearTimeout(timer);
        channel.close();
        popup.close();
        if (this.cancel === finish) this.cancel = undefined;
        if (error) reject(error); else resolve(value!);
      };
      this.cancel = finish;
      channel.onmessage = (event: MessageEvent) => {
        if (event.data?.type !== 'gitea-oauth-callback' || typeof event.data.url !== 'string') return;
        try {
          if (isCallback(this.site, event.data.url, state)) finish(undefined, new URL(event.data.url).href);
        } catch { finish(new Error('Invalid authorization response.')); }
      };
    });
  }
}
