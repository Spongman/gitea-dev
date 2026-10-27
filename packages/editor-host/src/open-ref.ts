import { validateLaunch, type LaunchDescriptor, type RefKind } from './launch.js';

interface RefTarget {
  ref: string;
  refKind: RefKind;
  /** Defaults to the current repository; a pull request from a fork opens the fork. */
  owner?: string;
  repository?: string;
}

/** Launch URL for another ref, on the current page path. Throws LaunchError unless validateLaunch accepts it. */
export function openRefUrl(current: LaunchDescriptor, target: RefTarget, page: { origin: string; pathname: string }): URL {
  const url = new URL(page.pathname, page.origin);
  url.searchParams.set('owner', target.owner ?? current.owner);
  url.searchParams.set('repository', target.repository ?? current.repository);
  url.searchParams.set('ref', target.ref);
  url.searchParams.set('refKind', target.refKind);
  validateLaunch(url, current.instance);
  return url;
}
