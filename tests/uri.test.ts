import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWorkspaceAuthority, encodeWorkspaceAuthority } from '../packages/gitea-repository/src/workspace-uri.js';
import { descriptorIdentity, parseDescriptor, queryForUri } from '../packages/gitea-vscode-web/src/descriptor.js';

test('workspace identity survives language services discarding URI queries', () => {
  const descriptor = { instance: 'https://git.example/sub', owner: 'alice', repository: 'demo', ref: 'feature/\u65e5\u672c\u8a9e%2F', refKind: 'branch' as const };
  const authority = encodeWorkspaceAuthority(descriptor);
  assert.match(authority, /^r[0-9a-f]+$/);
  const path = `/gitea-vfs/${authority}/src/main.ts`;
  const rebuiltAuthority = path.split('/')[2].toLowerCase();
  assert.deepEqual(parseDescriptor(queryForUri({ authority: rebuiltAuthority, query: '' })), descriptor);
  assert.equal(decodeWorkspaceAuthority(authority), JSON.stringify(descriptor));
});

test('same named branches and tags have distinct overlay identities', () => {
  const descriptor = { instance: 'https://git.example', owner: 'alice', repository: 'demo', ref: 'release' };
  assert.notEqual(descriptorIdentity({ ...descriptor, refKind: 'branch' }), descriptorIdentity({ ...descriptor, refKind: 'tag' }));
});

test('malformed authorities and credential-bearing descriptors are rejected', () => {
  for (const authority of ['repository', 'r0', 'rzz', 'r00', 'r' + '00'.repeat(9000)]) {
    assert.throws(() => parseDescriptor(decodeWorkspaceAuthority(authority)));
  }
  const authority = encodeWorkspaceAuthority({ instance: 'https://git.example', owner: 'alice', repository: 'demo', ref: 'main', token: 'secret' });
  assert.throws(() => parseDescriptor(decodeWorkspaceAuthority(authority)), /credentials/);
});

test('encoding refuses a descriptor whose authority the decoder would reject', () => {
  const fits = { pad: 'x'.repeat(8192 - JSON.stringify({ pad: '' }).length) };
  assert.equal(decodeWorkspaceAuthority(encodeWorkspaceAuthority(fits)), JSON.stringify(fits));
  assert.throws(() => encodeWorkspaceAuthority({ pad: 'x'.repeat(8193 - JSON.stringify({ pad: '' }).length) }), /too large|Invalid/i);
});
