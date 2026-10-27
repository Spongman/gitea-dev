import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { extractArchive, type ExtractOptions } from './archive.js';
import { AssetError, integrityOf, type AssetPin, type WorkbenchManifest } from './types.js';
import { validateAssets, writeManifest } from './validate.js';

export async function sha256File(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest('hex');
}

// Verifies the archive digest, extracts into an empty dest, checks that the
// bytes extraction read match the digest too (the file may have changed
// since the first check), writes the trusted manifest from the pin and
// validates the result. The official archive carries no manifest of its own.
// dest is left behind on failure once extraction starts; callers own cleanup
// (use a staging dir).
export async function installArchive(
	archive: string,
	pin: AssetPin,
	dest: string,
	options: ExtractOptions = {},
): Promise<WorkbenchManifest> {
	const actual = await sha256File(archive);
	if (actual !== pin.sha256) {
		throw new AssetError('checksum', `sha256 mismatch for ${archive}: expected ${pin.sha256}, got ${actual}`);
	}
	await mkdir(dest, { recursive: true });
	const extracted = await extractArchive(archive, dest, options);
	if (extracted.sha256 !== pin.sha256) {
		throw new AssetError('checksum', `${archive} changed during extraction: expected ${pin.sha256}, read ${extracted.sha256}`);
	}
	const manifest: WorkbenchManifest = {
		schema: 1,
		version: pin.version,
		commit: pin.commit,
		clientOnly: true,
		integrity: integrityOf(pin.sha256),
	};
	await writeManifest(dest, manifest);
	return validateAssets(dest, {
		expected: { version: pin.version, commit: pin.commit, integrity: manifest.integrity },
		limits: options.limits,
	});
}

export const removeTree = (path: string): Promise<void> => rm(path, { recursive: true, force: true });
