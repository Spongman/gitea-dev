import { RepositoryError } from './errors.js';

const CHUNK = 0x8000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
	}
	return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
	const clean = text.replace(/\s+/g, '');
	if (clean.length % 4 !== 0 || !BASE64_PATTERN.test(clean)) {
		throw new RepositoryError('protocol', 'Server returned invalid base64');
	}
	const binary = atob(clean);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/** Git object id of a blob: hash of "blob <size>\0" + content. */
export async function gitBlobSha(content: Uint8Array, hexLength: number): Promise<string> {
	const header = new TextEncoder().encode(`blob ${content.length}\0`);
	const data = new Uint8Array(header.length + content.length);
	data.set(header, 0);
	data.set(content, header.length);
	const digest = await crypto.subtle.digest(hexLength === 64 ? 'SHA-256' : 'SHA-1', data);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(content: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', content as BufferSource);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const LFS_VERSION = 'version https://git-lfs.github.com/spec/v1';
const LFS_LINE = /^([a-z0-9.-]+) ([^\r\n]+)$/;
const LFS_OID = /^sha256:([0-9a-f]{64})$/;
const LFS_SIZE = /^(?:0|[1-9][0-9]*)$/;
const MAX_LFS_POINTER_BYTES = 1024;
/** Smallest possible pointer file: version line, oid line and "size 0" without a final newline. */
const MIN_LFS_POINTER_BYTES = 125;

/** Whether a blob of this size can be a Git LFS pointer; lets callers skip reading other blobs. */
export function mayBeLfsPointer(size: number): boolean {
	return size >= MIN_LFS_POINTER_BYTES && size <= MAX_LFS_POINTER_BYTES;
}

/**
 * The object id and size of a Git LFS pointer file; undefined for any other bytes. Follows the
 * spec: version line first, then `key value` lines in ascending key order (extension keys
 * included), nothing after the last line. A missing final newline is accepted, as git-lfs does.
 */
export function parseLfsPointer(content: Uint8Array): { oid: string; size: number } | undefined {
	if (!mayBeLfsPointer(content.length)) {
		return undefined;
	}
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
	} catch {
		return undefined;
	}
	const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
	if (lines[0] !== LFS_VERSION) {
		return undefined;
	}
	const values = new Map<string, string>();
	let previous = '';
	for (const line of lines.slice(1)) {
		const match = LFS_LINE.exec(line);
		if (match === null || match[1] === 'version' || match[1] <= previous) {
			return undefined;
		}
		previous = match[1];
		values.set(match[1], match[2]);
	}
	const oid = LFS_OID.exec(values.get('oid') ?? '')?.[1];
	const sizeText = values.get('size') ?? '';
	const size = LFS_SIZE.test(sizeText) ? Number(sizeText) : NaN;
	return oid === undefined || !Number.isSafeInteger(size) ? undefined : { oid, size };
}

/** True when the bytes are a well-formed Git LFS pointer file. */
export function isLfsPointer(content: Uint8Array): boolean {
	return parseLfsPointer(content) !== undefined;
}
