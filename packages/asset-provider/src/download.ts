import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { AssetError, DEFAULT_DOWNLOAD_TIMEOUT_MS, type ArchiveLimits } from './types.js';

interface DownloadOptions {
	url: string;
	sha256: string;
	dest: string;
	limits: Pick<ArchiveLimits, 'maxCompressedBytes'>;
	allowFileUrls?: boolean;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

// Streams url into dest while hashing. dest is removed and AssetError
// thrown unless the sha256 matches; nothing is extracted or executed here.
export async function downloadVerified(options: DownloadOptions): Promise<void> {
	const { url, sha256, dest, limits } = options;
	const hash = createHash('sha256');
	let bytes = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			bytes += chunk.length;
			if (bytes > limits.maxCompressedBytes) {
				callback(new AssetError('limit', 'download exceeds compressed size limit'));
				return;
			}
			hash.update(chunk);
			callback(null, chunk);
		},
	});

	try {
		const source = await open(options);
		await pipeline(source, meter, createWriteStream(dest, { flags: 'wx', mode: 0o644 }));
	} catch (error) {
		await rm(dest, { force: true });
		if (error instanceof AssetError) throw error;
		throw new AssetError('download', `download of ${redact(url)} failed: ${(error as Error).message}`, {
			cause: error,
		});
	}
	const actual = hash.digest('hex');
	if (actual !== sha256) {
		await rm(dest, { force: true });
		throw new AssetError('checksum', `sha256 mismatch for ${redact(url)}: expected ${sha256}, got ${actual}`);
	}
}

async function open(options: DownloadOptions): Promise<Readable> {
	const { url, limits } = options;
	const parsed = new URL(url);
	if (parsed.protocol === 'file:') {
		if (!options.allowFileUrls) throw new AssetError('download', 'file:// URLs are not allowed');
		const path = fileURLToPath(parsed);
		if ((await stat(path)).size > limits.maxCompressedBytes) {
			throw new AssetError('limit', 'archive exceeds compressed size limit');
		}
		return createReadStream(path);
	}
	if (parsed.protocol !== 'https:') throw new AssetError('download', 'only https URLs are allowed');
	const response = await (options.fetch ?? fetch)(url, {
		redirect: 'follow',
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new AssetError('download', `GET ${redact(url)} returned HTTP ${response.status}`);
	}
	if (response.url && new URL(response.url).protocol !== 'https:') {
		await response.body.cancel();
		throw new AssetError('download', 'redirected to a non-https URL');
	}
	const length = Number(response.headers.get('content-length'));
	if (length > limits.maxCompressedBytes) {
		await response.body.cancel();
		throw new AssetError('limit', 'archive exceeds compressed size limit');
	}
	return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
}

// Drop query strings (may carry tokens) from logged URLs.
const redact = (url: string): string => {
	const parsed = new URL(url);
	return `${parsed.origin}${parsed.pathname}`;
};
