// Resource payload encoding for Gitea variables: UTF-8, gzip, base64url, split into chunks.
// Gitea stores at most 65536 characters per variable (verified, docs/settings-sync.md); the
// chunk size leaves headroom.

export const CHUNK_CHARS = 60_000;

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Invalid base64url');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pump(input: Uint8Array, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Errors surface on the readable side.
  void writer.write(input as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => undefined);
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel(); throw new Error('Decompressed payload too large'); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** UTF-8 text to one base64url string. */
export async function encode(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return base64url(await pump(bytes, new CompressionStream('gzip'), bytes.length + 1024));
}

/** Inverse of encode; `limit` bounds the decompressed size in bytes. */
export async function decode(encoded: string, limit: number): Promise<string> {
  const bytes = await pump(fromBase64url(encoded), new DecompressionStream('gzip'), limit);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function split(encoded: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += size) chunks.push(encoded.slice(i, i + size));
  return chunks;
}
