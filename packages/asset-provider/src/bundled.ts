import { resolve } from 'node:path';
import { parsePin } from './pin.js';
import {
	AssetError,
	DEFAULT_LIMITS,
	integrityOf,
	type ArchiveLimits,
	type AssetPin,
	type WorkbenchAssets,
	type WorkbenchAssetsResult,
} from './types.js';
import { readManifest, validateAssets } from './validate.js';

export interface BundledAssetsOptions {
	// Directory holding the workbench tree and workbench-assets.json.
	root: string;
	// When given, the bundled manifest must match this pin exactly.
	pin?: AssetPin;
	limits?: Partial<ArchiveLimits>;
}

// Offline/reproducible mode: serves a pre-built tree, validated on every
// ensure() call. No download, no fallback.
export class BundledAssets implements WorkbenchAssets {
	private readonly root: string;
	private readonly pin?: AssetPin;
	private readonly limits: ArchiveLimits;

	constructor(options: BundledAssetsOptions) {
		this.root = resolve(options.root);
		this.pin = options.pin ? parsePin(options.pin, { allowFileUrls: true }) : undefined;
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
	}

	async ensure(version: string): Promise<WorkbenchAssetsResult> {
		if (this.pin && version !== this.pin.version) {
			throw new AssetError('version-mismatch', `requested ${version} but the configured pin is ${this.pin.version}`);
		}
		const bundled = await readManifest(this.root);
		if (bundled.version !== version) {
			throw new AssetError('version-mismatch', `bundled workbench is ${bundled.version}, requested ${version}`);
		}
		const manifest = await validateAssets(this.root, {
			expected: {
				version,
				commit: this.pin?.commit,
				integrity: this.pin ? integrityOf(this.pin.sha256) : undefined,
			},
			limits: this.limits,
		});
		return { root: this.root, version: manifest.version, commit: manifest.commit, integrity: manifest.integrity };
	}
}
