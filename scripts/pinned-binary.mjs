// Downloads a release binary pinned by URL and sha256, once. The checksum published next to the
// binary must also match the pin. Shared by scripts/local-instance.mjs and scripts/test-gitea.mjs.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Ensures `binary` exists with the pinned digest, downloading `url` if needed. Returns `binary`. */
export async function ensurePinnedBinary({ binary, url, sha256, mode = 0o755, timeoutMs = 600_000, fetch: fetcher = fetch }) {
  if (await sha256File(binary).catch(() => '') === sha256) return binary;
  await mkdir(dirname(binary), { recursive: true });
  const get = async target => {
    const response = await fetcher(target, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || !response.body) throw new Error(`GET ${target} failed: HTTP ${response.status}`);
    return response;
  };
  const name = basename(new URL(url).pathname);
  const published = (await (await get(`${url}.sha256`)).text()).trim();
  const [publishedSha, publishedName] = published.split(/\s+/);
  if (publishedSha !== sha256 || (publishedName && publishedName.replace(/^\*/, '') !== name)) {
    throw new Error(`Published checksum for ${name} does not match the pin (published: ${published}); refusing to download.`);
  }
  const temporary = `${binary}.${randomBytes(6).toString('hex')}.part`;
  try {
    await pipeline(Readable.fromWeb((await get(url)).body), createWriteStream(temporary, { mode: 0o600 }));
    const actual = await sha256File(temporary);
    if (actual !== sha256) throw new Error(`Downloaded ${name} checksum mismatch: got ${actual}, pinned ${sha256}.`);
    await chmod(temporary, mode);
    await rename(temporary, binary);
  } finally { await rm(temporary, { force: true }); }
  return binary;
}
