import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LaunchError, launchPath, validateLaunch } from '../packages/editor-host/src/launch.ts';

const INSTANCE = 'https://gitea.example';
const HOST = `${INSTANCE}/assets/gitea-dev/index.html`;

function launch(query: string, instance = INSTANCE, host = HOST) {
  return validateLaunch(new URL(`${host}?${query}`), instance);
}

function rejects(fn: () => unknown, pattern?: RegExp) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof LaunchError, `expected LaunchError, got ${String(error)}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

describe('validateLaunch accepts', () => {
  it('a branch descriptor', () => {
    assert.deepEqual(launch('owner=alice&repository=proj&ref=main&refKind=branch'), {
      instance: INSTANCE,
      owner: 'alice',
      repository: 'proj',
      ref: 'main',
      refKind: 'branch',
    });
  });

  it('a descriptor without refKind and omits the field', () => {
    const descriptor = launch('owner=alice&repository=proj&ref=main');
    assert.equal('refKind' in descriptor, false);
  });

  it('a file path, kept out of the descriptor', () => {
    const query = 'owner=a&repository=b&ref=main&path=src%2Fmy%20file.ts';
    assert.equal('path' in launch(query), false);
    assert.equal(launchPath(new URL(`${HOST}?${query}`)), 'src/my file.ts');
    assert.equal(launchPath(new URL(`${HOST}?owner=a&repository=b&ref=main`)), undefined);
  });

  it('a tag', () => {
    assert.equal(launch('owner=a&repository=b&ref=v1.0.0&refKind=tag').refKind, 'tag');
  });

  it('a commit id and lowercases it', () => {
    const descriptor = launch('owner=a&repository=b&ref=ABCDEF1234&refKind=commit');
    assert.equal(descriptor.ref, 'abcdef1234');
    assert.equal(descriptor.refKind, 'commit');
  });

  it('refs with slashes, encoded slashes and Unicode', () => {
    assert.equal(launch('owner=a&repository=b&ref=feature/x/y').ref, 'feature/x/y');
    assert.equal(launch('owner=a&repository=b&ref=feature%2Fx').ref, 'feature/x');
    assert.equal(launch('owner=a&repository=b&ref=%E3%83%96%E3%83%A9%E3%83%B3%E3%83%81').ref, String.fromCodePoint(0x30d6, 0x30e9, 0x30f3, 0x30c1));
  });

  it('an instance under a sub-path and normalizes a trailing slash', () => {
    const descriptor = launch(
      'owner=a&repository=b&ref=main',
      'https://gitea.example/git/',
      'https://gitea.example/git/assets/gitea-dev/index.html',
    );
    assert.equal(descriptor.instance, 'https://gitea.example/git');
  });

  it('http on loopback hosts and non-default ports', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const descriptor = launch(
        'owner=a&repository=b&ref=main',
        `http://${host}:3000`,
        `http://${host}:3000/assets/gitea-dev/index.html`,
      );
      assert.equal(descriptor.instance, `http://${host}:3000`);
    }
  });

  it('owner and repository names Gitea allows', () => {
    const descriptor = launch('owner=Alice-1.x_y&repository=.github&ref=main');
    assert.equal(descriptor.owner, 'Alice-1.x_y');
    assert.equal(descriptor.repository, '.github');
  });
});

describe('validateLaunch rejects instance configuration', () => {
  const query = 'owner=a&repository=b&ref=main';
  it('http on a remote host', () => {
    rejects(() => launch(query, 'http://gitea.example', 'http://gitea.example/x'), /https/);
  });
  it('credentials, query, fragment, non-URL, odd sub-paths', () => {
    rejects(() => launch(query, 'https://u:p@gitea.example'));
    rejects(() => launch(query, 'https://gitea.example/?x=1'));
    rejects(() => launch(query, 'https://gitea.example/#x'));
    rejects(() => launch(query, 'not a url'));
    rejects(() => launch(query, 'https://gitea.example/a/../b'));
    rejects(() => launch(query, 'https://gitea.example/a%2Fb'));
    rejects(() => launch(query, 'ftp://gitea.example'));
  });
});

describe('validateLaunch rejects the launch URL', () => {
  const query = 'owner=a&repository=b&ref=main';

  it('a path that is empty, absolute, or has "." or ".." segments', () => {
    for (const path of ['', '/etc/passwd', 'a//b', 'a/../b', './a', 'a/', 'a%5Cb', 'a%00b']) {
      rejects(() => launch(`${query}&path=${path}`), /path/);
    }
  });

  it('credentials', () => {
    rejects(() => launch(query, INSTANCE, 'https://u:p@gitea.example/assets/gitea-dev/index.html'), /credentials/);
  });

  it('a remote authority, other port or other scheme', () => {
    rejects(() => launch(query, INSTANCE, 'https://evil.example/assets/gitea-dev/index.html'), /origin/);
    rejects(() => launch(query, INSTANCE, 'https://gitea.example:8443/assets/gitea-dev/index.html'), /origin/);
    rejects(() => launch(query, INSTANCE, 'http://gitea.example/assets/gitea-dev/index.html'), /origin/);
    rejects(() => launch(query, INSTANCE, 'https://gitea.example.evil.example/x'), /origin/);
  });

  it('a path outside the sub-path, including traversal out of it', () => {
    const sub = 'https://gitea.example/git';
    rejects(() => launch(query, sub, 'https://gitea.example/assets/gitea-dev/index.html'), /sub-path/);
    rejects(() => launch(query, sub, 'https://gitea.example/gitx/assets/index.html'), /sub-path/);
    rejects(() => launch(query, sub, 'https://gitea.example/git/../evil/index.html'), /sub-path/);
    rejects(() => launch(query, sub, 'https://gitea.example/git/%2e%2e/evil/index.html'), /sub-path/);
  });

  it('encoded separators in the path and fragments', () => {
    rejects(() => launch(query, INSTANCE, 'https://gitea.example/assets%2Fgitea-dev/index.html'), /encoded/);
    rejects(() => launch(query, INSTANCE, 'https://gitea.example/assets%5Cgitea-dev/index.html'), /encoded/);
    rejects(() => validateLaunch(new URL(`${HOST}?${query}#access_token=s3cret`), INSTANCE), /fragment/);
  });

  it('unknown or secret query parameters without echoing values', () => {
    for (const extra of ['token=s3cret', 'access_token=s3cret', 'password=s3cret', 'x=1']) {
      assert.throws(
        () => launch(`${query}&${extra}`),
        (error: unknown) => {
          assert.ok(error instanceof LaunchError);
          assert.doesNotMatch(error.message, /s3cret/);
          return true;
        },
      );
    }
  });

  it('repeated parameters', () => {
    rejects(() => launch('owner=a&owner=b&repository=b&ref=main'), /repeats/);
  });

  it('missing required parameters', () => {
    rejects(() => launch('repository=b&ref=main'), /owner/);
    rejects(() => launch('owner=a&ref=main'), /repository/);
    rejects(() => launch('owner=a&repository=b'), /ref/);
    rejects(() => launch('owner=&repository=b&ref=main'), /owner/);
  });

  it('invalid encoding', () => {
    rejects(() => launch('owner=a&repository=b&ref=ma%zzin'), /percent/);
    rejects(() => launch('owner=a&repository=b&ref=ma%'), /percent/);
    rejects(() => launch('owner=a&repository=b&ref=ma%ffin'), /encoding/);
    rejects(() => launch('owner=a&repository=b&ref=ma%C3'), /encoding/);
  });

  it('newlines, control characters and bidi controls in any field', () => {
    for (const bad of ['%0A', '%0D', '%00', '%1F', '%7F', '%C2%85', '%E2%80%AE', '%E2%80%A8']) {
      rejects(() => launch(`owner=a&repository=b&ref=ma${bad}in`));
      rejects(() => launch(`owner=a${bad}&repository=b&ref=main`));
      rejects(() => launch(`owner=a&repository=b${bad}&ref=main`));
    }
  });

  it('invalid refKind', () => {
    rejects(() => launch('owner=a&repository=b&ref=main&refKind=pull'), /refKind/);
    rejects(() => launch('owner=a&repository=b&ref=main&refKind='), /refKind/);
    rejects(() => launch('owner=a&repository=b&ref=main&refKind=Branch'), /refKind/);
  });

  it('invalid owners', () => {
    for (const owner of ['-a', '.a', '_a', 'a-', 'a.', 'a..b', 'a--b', 'a_.b', 'a%2Fb', 'a b', 'a%5Cb', '..', '.', 'a%40b', 'caf%C3%A9']) {
      rejects(() => launch(`owner=${owner}&repository=b&ref=main`), /owner/);
    }
  });

  it('invalid repositories', () => {
    for (const repository of ['.', '..', '-', 'a..b', 'a.git', 'a.WIKI', 'a.rss', 'a.atom', 'a%2Fb', 'a b', 'a%5Cb', '%2E%2E', 'a%3Fb']) {
      rejects(() => launch(`owner=a&repository=${repository}&ref=main`), /repository/);
    }
  });

  it('invalid branch and tag names', () => {
    const bad = ['a..b', '-x', 'a b', 'a%09b', 'x.lock', 'a/x.lock', '@', 'a@{b', 'a//b', '/a', 'a/', 'a.', '.a', 'a/.b',
      'a~b', 'a^b', 'a:b', 'a%3Fb', 'a*b', 'a[b', 'a%5Cb', '..%2F..%2Fetc%2Fpasswd'];
    for (const ref of bad) {
      for (const kind of ['', '&refKind=branch', '&refKind=tag']) {
        rejects(() => launch(`owner=a&repository=b&ref=${ref}${kind}`), /ref/);
      }
    }
  });

  it('commit refs that are not commit ids', () => {
    for (const ref of ['main', 'abc12', 'xyz1234', `${'a'.repeat(65)}`, 'abcdef1/x']) {
      rejects(() => launch(`owner=a&repository=b&ref=${ref}&refKind=commit`), /commit/);
    }
  });

  it('overlong values', () => {
    rejects(() => launch(`owner=a&repository=b&ref=${'a'.repeat(256)}`), /too long/);
    rejects(() => launch(`owner=${'a'.repeat(256)}&repository=b&ref=main`), /too long/);
  });

  it('a non-URL input', () => {
    rejects(() => validateLaunch(`${HOST}?owner=a` as unknown as URL, INSTANCE), /URL/);
  });
});
