export type RefKind = 'branch' | 'tag' | 'commit';

export interface LaunchDescriptor {
  instance: string;
  owner: string;
  repository: string;
  ref: string;
  refKind?: RefKind;
}

export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchError';
  }
}

const ALLOWED_KEYS = new Set(['owner', 'repository', 'ref', 'refKind', 'path']);
const REF_KINDS = new Set<string>(['branch', 'tag', 'commit']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_NAME = 255;
const MAX_REF = 255;
const MAX_PATH = 4096;

// Mirrors Gitea v1.24.6 modules/validation IsValidUsername.
const OWNER_VALID = /^[0-9A-Za-z][-.\w]*$/;
const OWNER_INVALID = /[-._]{2,}|[-._]$/;
// Mirrors Gitea v1.24.6 models/repo IsUsableRepoName.
const REPO_VALID = /^[-.\w]+$/;
const REPO_INVALID = /[.]{2,}/;
const REPO_RESERVED = new Set(['.', '..', '-']);
const REPO_RESERVED_SUFFIX = /\.(wiki|git|rss|atom)$/i;

const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
const BAD_PERCENT = /%(?![0-9A-Fa-f]{2})/;
const ENCODED_SEPARATOR = /%(2f|5c|00)/i;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;
const REF_FORBIDDEN_CHARS = /[\s~^:?*[\\]/;

interface Instance {
  origin: string;
  prefix: string;
}

function fail(message: string): never {
  throw new LaunchError(message);
}

function parseInstance(instance: string): Instance {
  if (/[?#]/.test(instance)) fail('instance must not have a query or fragment');
  let url: URL;
  try {
    url = new URL(instance);
  } catch {
    return fail('instance is not a valid URL');
  }
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    fail('instance must be https, or http on a loopback host');
  }
  if (url.username || url.password) fail('instance must not contain credentials');
  const prefix = url.pathname.replace(/\/+$/, '');
  for (const segment of prefix.split('/').slice(1)) {
    if (!PATH_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      fail('instance path is not a plain sub-path');
    }
  }
  return { origin: url.origin, prefix };
}

function checkText(field: string, value: string, max: number): void {
  if (value === '') fail(`${field} is required`);
  if (value.length > max) fail(`${field} is too long`);
  if (CONTROL_CHARS.test(value) || value.includes(REPLACEMENT_CHAR)) fail(`${field} has invalid characters or encoding`);
}

function validateOwner(owner: string): void {
  if (!OWNER_VALID.test(owner) || OWNER_INVALID.test(owner)) fail('owner is not a valid Gitea user name');
}

function validateRepository(repository: string): void {
  if (
    !REPO_VALID.test(repository) ||
    REPO_INVALID.test(repository) ||
    REPO_RESERVED.has(repository) ||
    REPO_RESERVED_SUFFIX.test(repository)
  ) {
    fail('repository is not a valid Gitea repository name');
  }
}

// Subset of git check-ref-format, applied to branch and tag names.
function validateRefName(ref: string): void {
  const bad =
    ref.startsWith('-') ||
    ref === '@' ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.includes('//') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    REF_FORBIDDEN_CHARS.test(ref) ||
    ref.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'));
  if (bad) fail('ref is not a valid branch or tag name');
}

// A repository-relative file path: no empty, "." or ".." segments.
function validatePath(path: string): void {
  checkText('path', path, MAX_PATH);
  if (path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail('path is not a repository-relative file path');
  }
}

/** The file to open at start (`path` query parameter), or undefined. Not part of the workspace identity. */
export function launchPath(input: URL): string | undefined {
  return input.searchParams.get('path') ?? undefined;
}

export function validateLaunch(input: URL, instance: string): LaunchDescriptor {
  const inst = parseInstance(instance);

  if (!(input instanceof URL)) fail('input must be a URL');
  if (input.username || input.password) fail('launch URL must not contain credentials');
  if (input.origin !== inst.origin) fail('launch URL is not on the configured instance origin');
  if (input.hash) fail('launch URL must not have a fragment');
  if (ENCODED_SEPARATOR.test(input.pathname)) fail('launch URL path has an encoded separator');
  const path = input.pathname;
  if (inst.prefix !== '' && path !== inst.prefix && !path.startsWith(`${inst.prefix}/`)) {
    fail('launch URL is outside the instance sub-path');
  }

  if (BAD_PERCENT.test(input.search)) fail('launch URL query has invalid percent-encoding');
  const values = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(input.search)) {
    if (!ALLOWED_KEYS.has(key)) fail('launch URL has an unsupported query parameter');
    if (values.has(key)) fail(`launch URL repeats ${key}`);
    values.set(key, value);
  }

  const owner = values.get('owner') ?? '';
  const repository = values.get('repository') ?? '';
  const ref = values.get('ref') ?? '';
  const refKind = values.get('refKind');
  checkText('owner', owner, MAX_NAME);
  checkText('repository', repository, MAX_NAME);
  checkText('ref', ref, MAX_REF);
  validateOwner(owner);
  validateRepository(repository);
  if (values.has('path')) validatePath(values.get('path')!);

  if (refKind !== undefined && !REF_KINDS.has(refKind)) fail('refKind must be branch, tag or commit');
  let normalizedRef = ref;
  if (refKind === 'commit') {
    if (!COMMIT_ID.test(ref)) fail('ref is not a commit id');
    normalizedRef = ref.toLowerCase();
  } else {
    validateRefName(ref);
  }

  const descriptor: LaunchDescriptor = {
    instance: inst.origin + inst.prefix,
    owner,
    repository,
    ref: normalizedRef,
  };
  if (refKind !== undefined) descriptor.refKind = refKind as RefKind;
  return descriptor;
}
