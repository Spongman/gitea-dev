import { encodeWorkspaceAuthority } from '../../gitea-repository/src/workspace-uri.js';
import { openRefUrl } from './open-ref.js';
import { PersistentSecretStorage, secretScope } from './secret-storage.js';
import { launchPath, validateLaunch, type LaunchDescriptor } from './launch.js';
import { galleryProductConfiguration, type GalleryProductConfiguration } from './gallery.js';
import { COLOR_SCHEME_GLOBAL, CONFIGURATION_GLOBAL, WORKBENCH_MAIN, WORKBENCH_NLS, workbenchRoot, type DeploymentConfiguration } from './deployment.js';
import { syncProductConfiguration } from './sync-config.js';
import { acceptSyncQuickInputs } from './sync-turn-on.js';
import { PopupSignIn, authorizationRequest, isCallback, type OAuthSite } from './oauth.js';
import { rememberConfirmedScheme, themeDefaults, type ColorScheme } from './theme.js';

interface HostConfiguration {
  launch: LaunchDescriptor;
  assets: string;
  extension: string;
  testMode: boolean;
  extensionsGallery?: GalleryProductConfiguration;
  oauth?: { clientId: string; redirectUri: string };
}

// Set by start.ts from configuration.json; launch validation runs here, in the browser.
const deployment: DeploymentConfiguration = (globalThis as Record<string, any>)[CONFIGURATION_GLOBAL];
const config: HostConfiguration = {
  launch: validateLaunch(new URL(location.href), deployment.instance),
  assets: workbenchRoot(new URL('./', import.meta.url), deployment).href,
  extension: new URL('extension/', import.meta.url).href,
  testMode: deployment.testMode === true,
  extensionsGallery: deployment.gallery ? galleryProductConfiguration(deployment.gallery) : undefined,
  oauth: deployment.oauthClientId
    ? { clientId: deployment.oauthClientId, redirectUri: new URL('../oauth-callback.html', import.meta.url).href } : undefined,
};
// Started by start.ts before the workbench loads, so the theme request overlaps it.
const colorScheme: Promise<ColorScheme> = (globalThis as Record<string, any>)[COLOR_SCHEME_GLOBAL];
Object.assign(globalThis, {
  _VSCODE_FILE_ROOT: new URL('out/', config.assets).href,
  _VSCODE_NLS_LANGUAGE: 'en',
});
// CDN workbench: its loader of node_modules packages (xterm and others) accepts only same-origin
// script URLs unless this Trusted Types policy is supplied.
if (deployment.workbench) {
  const trustedTypes = (globalThis as { trustedTypes?: { createPolicy(name: string, rules: object): unknown } }).trustedTypes;
  Object.assign(globalThis, {
    _VSCODE_WEB_PACKAGE_TTP: trustedTypes?.createPolicy('giteaWorkbenchPackages', {
      createScriptURL: (url: string) => {
        if (url.startsWith(config.assets)) return url;
        throw new Error(`Invalid script url: ${url}`);
      },
    }),
  });
}
// CDN workbench: the extension host iframe runs on https://<uuid>.vscode-cdn.net/<quality>/<commit>/.
const [quality, commit] = deployment.workbench ? new URL(deployment.workbench).pathname.split('/').filter(Boolean) : [];
await import(new URL(WORKBENCH_NLS, config.assets).href);
const api = await import(new URL(WORKBENCH_MAIN, config.assets).href);
const folderUri = api.URI.from({
  scheme: 'gitea-vfs', authority: encodeWorkspaceAuthority(config.launch), path: '/',
});
// The "." shortcut on a file page passes `path`. It is dropped from the address so a reload restores
// the session's editors instead of reopening the file.
const filePath = launchPath(new URL(location.href));
if (filePath !== undefined) {
  const clean = new URL(location.href);
  clean.searchParams.delete('path');
  history.replaceState(history.state, '', clean);
}
const secretStorage = new PersistentSecretStorage({ scope: secretScope(config.launch.instance) });
const oauthSite: OAuthSite | undefined = config.oauth && {
  origin: location.origin,
  authorizePath: `${new URL(config.launch.instance).pathname.replace(/\/$/, '')}/login/oauth/authorize`,
  redirectPath: new URL(config.oauth.redirectUri).pathname,
};
const popupSignIn = oauthSite && new PopupSignIn(oauthSite, href => window.open(href, 'gitea-oauth', 'popup,width=700,height=800'));
const hideQuickInputs = document.createElement('style');
hideQuickInputs.textContent = '.quick-input-widget { visibility: hidden !important; }';
api.create(document.body, {
  commands: [
    { id: 'giteaHost.authConfiguration', handler: () => config.oauth },
    // A browser has no process terminal; New Terminal opens the extension's shell instead.
    { id: 'workbench.action.terminal.new', handler: () => api.commands.executeCommand('gitea.openShell') },
    // Theme confirmation after sign-in (packages/gitea-vscode-web/src/theme-confirm.ts).
    { id: 'giteaHost.colorScheme', handler: () => colorScheme },
    { id: 'giteaHost.confirmColorScheme', handler: (scheme: unknown) => rememberConfirmedScheme(globalThis.localStorage, scheme) },
    // Native Settings Sync turn-on with its quick inputs answered by default (docs/settings-sync.md).
    { id: 'giteaHost.syncTurnOn', handler: () => acceptSyncQuickInputs(
      () => api.commands.executeCommand('workbench.userDataSync.actions.turnOn'),
      () => api.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'),
      { hide: hidden => hidden ? document.head.append(hideQuickInputs) : hideQuickInputs.remove() }) },
    // Reloads at another ref; pending changes are stored per ref, so they wait there.
    { id: 'giteaHost.openRef', handler: (target: Parameters<typeof openRefUrl>[1]) => location.assign(openRefUrl(config.launch as Parameters<typeof openRefUrl>[0], target, location).href) },
    { id: 'giteaHost.oauthAuthorize', handler: (authorizationUrl: string) => {
      if (!popupSignIn) throw new Error('OAuth is unavailable.');
      return popupSignIn.signIn(authorizationUrl);
    } },
    // Same-origin fetch that follows redirects: succeeds only when Gitea redirects straight back
    // (session plus existing grant). No iframe, so COEP and X-Frame-Options do not apply.
    { id: 'giteaHost.oauthAuthorizeSilent', handler: async (authorizationUrl: string) => {
      if (!oauthSite || popupSignIn!.pending) return undefined;
      const { url, state } = authorizationRequest(oauthSite, authorizationUrl);
      try {
        const response = await fetch(url.href, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
        return response.ok && isCallback(oauthSite, response.url, state) ? new URL(response.url).href : undefined;
      } catch { return undefined; }
    } },
  ],
  workspaceProvider: { workspace: { folderUri }, trusted: true, open: async () => false },
  ...(filePath === undefined ? {} : {
    defaultLayout: { force: true, editors: [{ uri: folderUri.with({ path: `/${filePath}` }), viewColumn: 1, openOnlyIfExists: true }] },
  }),
  // vscode-cdn keeps the workbench's default webview endpoint.
  webviewEndpoint: deployment.webviews === 'vscode-cdn' ? undefined : new URL('webview-disabled/', import.meta.url).href,
  additionalBuiltinExtensions: [api.URI.parse(config.extension)],
  enabledExtensions: ['gitea.gitea-vscode-web'],
  enableWorkspaceTrust: true,
  secretStorageProvider: secretStorage,
  productConfiguration: {
    nameShort: 'Gitea Web IDE', nameLong: 'Gitea Web IDE',
    applicationName: 'gitea-web-ide',
    extensionsGallery: config.extensionsGallery ? {
      ...config.extensionsGallery,
      controlUrl: undefined, cacheUrl: undefined, searchUrl: undefined,
      servicePPEUrl: undefined, nlsBaseUrl: undefined, publisherUrl: undefined,
    } : undefined,
    extensionEnabledApiProposals: { 'gitea.gitea-vscode-web': ['fileSearchProvider', 'textSearchProvider', 'scmActionButton', 'scmValidation'] },
    webEndpointUrl: undefined,
    webEndpointUrlTemplate: deployment.workbench ? 'https://{{uuid}}.vscode-cdn.net/{{quality}}/{{commit}}' : undefined,
    ...(deployment.workbench ? { quality, commit } : {}),
    webviewContentExternalBaseUrlTemplate: undefined,
    extensionRecommendations: {}, extensionTips: {},
    remoteExtensionTips: {}, virtualWorkspaceExtensionTips: {},
    configBasedExtensionTips: {}, exeBasedExtensionTips: {},
    chatParticipantRegistry: undefined, chatSessionRecommendations: [],
    remoteDefaultExtensionsIfInstalledLocally: [],
    'configurationSync.store': syncProductConfiguration(new URL('../sync/', import.meta.url).href), telemetryEnabled: false,
    enableTelemetry: false, experimentsEnabled: false,
    'configurationDefaults': { 'telemetry.telemetryLevel': 'off' },
  },
  configurationDefaults: {
    'telemetry.telemetryLevel': 'off', 'workbench.enableExperiments': false,
    'workbench.startupEditor': 'none', 'workbench.tips.enabled': false,
    'security.workspace.trust.enabled': true,
    'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
    'task.autoDetect': 'off', 'debug.onTaskErrors': 'abort',
    'chat.disableAIFeatures': true, 'git.enabled': false,
    'extensions.ignoreRecommendations': true,
    'mcp.access': 'none',
    'workbench.remoteIndicator.showExtensionRecommendations': false,
    'files.autoSave': 'off',
    ...themeDefaults(await colorScheme),
    // Operator allowlist: the workbench disables installed extensions outside it (advisory, browser-enforced).
    // The host extension is registered as a user extension, so it is listed too.
    ...(deployment.extensionsAllowlist ? { 'extensions.allowed': Object.fromEntries(['gitea.gitea-vscode-web', ...deployment.extensionsAllowlist].map(id => [id, true])) } : {}),
  },
  windowIndicator: { label: `$(repo) ${config.launch.owner}/${config.launch.repository}`, tooltip: config.launch.ref },
});
if (config.testMode) Object.assign(globalThis, { __giteaWorkbench: api, __giteaLaunch: config.launch, __giteaFolderUri: folderUri });
