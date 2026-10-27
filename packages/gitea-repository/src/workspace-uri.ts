const MAX_AUTHORITY_LENGTH = 16385;

/** Lowercase authority survives language-service path mapping without a URI query. */
export function encodeWorkspaceAuthority(descriptor: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(descriptor));
  const authority = `r${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  if (authority.length > MAX_AUTHORITY_LENGTH) throw new Error('Workspace descriptor is too large.');
  return authority;
}

export function decodeWorkspaceAuthority(authority: string): string {
  if (authority.length > MAX_AUTHORITY_LENGTH || !/^r(?:[0-9a-f]{2})+$/.test(authority)) throw new Error('Invalid workspace authority.');
  const pairs = authority.slice(1).match(/../g)!;
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(pairs, pair => parseInt(pair, 16)));
}
