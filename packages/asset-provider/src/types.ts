export interface WorkbenchAssetsResult {
	root: string;
	version: string;
	commit: string;
	// "sha256:<hex>" of the pinned archive the tree was built from.
	integrity: string;
	// Set only when the requested pin could not be served and the last
	// validated install was served instead.
	fallback?: { requestedVersion: string; reason: string };
}

export interface WorkbenchAssets {
	ensure(version: string): Promise<WorkbenchAssetsResult>;
}

export interface AssetPin {
	version: string;
	commit: string;
	url: string;
	sha256: string;
}

export interface WorkbenchManifest {
	schema: 1;
	version: string;
	commit: string;
	clientOnly: true;
	integrity: string;
}

export interface ArchiveLimits {
	maxCompressedBytes: number;
	maxUnpackedBytes: number;
	maxEntries: number;
	maxPathLength: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = {
	maxCompressedBytes: 256 * 1024 * 1024,
	maxUnpackedBytes: 1024 * 1024 * 1024,
	maxEntries: 100_000,
	maxPathLength: 512,
};

export const MANIFEST_NAME = 'workbench-assets.json';

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 600_000;

export type AssetErrorCode =
	| 'bad-pin'
	| 'version-mismatch'
	| 'download'
	| 'checksum'
	| 'limit'
	| 'unsafe-archive'
	| 'invalid-layout'
	| 'lock-timeout'
	| 'lock-lost'
	| 'destination-exists'
	| 'not-installed';

export class AssetError extends Error {
	readonly code: AssetErrorCode;
	constructor(code: AssetErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'AssetError';
		this.code = code;
	}
}

export const integrityOf = (sha256: string): string => `sha256:${sha256}`;
