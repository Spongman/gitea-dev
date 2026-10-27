/** Authentication provider id; must match contributes.authentication in the extension manifest. */
export const SYNC_PROVIDER_ID = 'gitea';
/** Gitea token scopes the variables API needs: read:user to read, write:user to create, update and delete. */
export const SYNC_SCOPES: readonly string[] = ['read:user', 'write:user'];

/** Same shape as ConfigurationSyncStore in the pinned src/vs/base/common/product.ts. */
interface ConfigurationSyncStore {
  url: string;
  insidersUrl: string;
  stableUrl: string;
  canSwitch?: boolean;
  authenticationProviders: Record<string, { scopes: string[] }>;
}

/**
 * The value for product key `configurationSync.store`. The workbench deep-merges
 * productConfiguration into its defaults, which name GitHub and Microsoft providers; the `web`
 * override is spread over the merged object on web, so it alone decides the providers.
 * `url` is the service worker's sync route; the client requests `<url>v1/...`.
 */
export function syncProductConfiguration(url: string): ConfigurationSyncStore & { web: ConfigurationSyncStore } {
  const store = (): ConfigurationSyncStore => ({
    url, stableUrl: url, insidersUrl: url, canSwitch: false,
    authenticationProviders: { [SYNC_PROVIDER_ID]: { scopes: [...SYNC_SCOPES] } },
  });
  return { ...store(), web: store() };
}
