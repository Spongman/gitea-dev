// Git LFS pointers, symlinks and submodules: pure helpers. Expectations follow the Git LFS
// pointer spec (version, oid sha256, size lines) and vscode.d.ts FileType.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { isLfsPointer, mayBeLfsPointer, parseLfsPointer, sha256Hex } from '../packages/gitea-repository/src/bytes.js';
import { fileTypeBits } from '../packages/gitea-vscode-web/src/file-type.js';

const enc = (text: string) => new TextEncoder().encode(text);
const OID = 'ab'.repeat(32);
const pointer = (size: string | number = 12, oid = OID) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

describe('Git LFS pointer', () => {
	it('parses the oid and size', () => {
		assert.deepEqual(parseLfsPointer(enc(pointer(12345))), { oid: OID, size: 12345 });
		assert.deepEqual(parseLfsPointer(enc(pointer(0))), { oid: OID, size: 0 });
		assert.equal(isLfsPointer(enc(pointer())), true);
	});

	it('accepts a missing final newline', () => {
		assert.deepEqual(parseLfsPointer(enc(pointer(7).trimEnd())), { oid: OID, size: 7 });
	});

	it('F10: accepts extension lines between version and oid, in key order', () => {
		const head = 'version https://git-lfs.github.com/spec/v1\n';
		const tail = `oid sha256:${OID}\nsize 7\n`;
		assert.deepEqual(parseLfsPointer(enc(`${head}ext-0-foo sha256:${OID}\n${tail}`)), { oid: OID, size: 7 });
		assert.deepEqual(parseLfsPointer(enc(`${head}ext-0-foo sha256:${OID}\next-1-bar sha256:${OID}\n${tail}`)), { oid: OID, size: 7 });
	});

	it('F10: rejects pointers that break the spec layout', () => {
		const head = 'version https://git-lfs.github.com/spec/v1\n';
		const ext = `ext-0-foo sha256:${OID}\n`;
		const bad = [
			`${pointer(7)}${ext}`,
			`${head}size 7\noid sha256:${OID}\n`,
			`${head}oid sha256:${OID}\nsize 7\nsize 7\n`,
			`oid sha256:${OID}\nversion https://git-lfs.github.com/spec/v1\nsize 7\n`,
			`${head}oid sha256:${OID}\n`,
			`${head}size 7\n`,
			`${pointer(7)}trailing`,
			`${pointer(7)}\n`,
			pointer('7abc'),
			pointer('7 '),
			`${head}oid sha256:${OID}\nsize 7\nz\n`,
			`${head}oid  sha256:${OID}\nsize 7\n`,
			pointer(7).replace(/\n/g, '\r\n'),
		];
		for (const text of bad) {
			assert.equal(parseLfsPointer(enc(text)), undefined, JSON.stringify(text.slice(0, 120)));
		}
	});

	it('rejects anything else', () => {
		const bad = [
			'',
			'hello',
			pointer(12, 'AB'.repeat(32)),
			pointer(12, 'ab'.repeat(31)),
			pointer(12, 'zz'.repeat(32)),
			pointer('-1'),
			pointer('x'),
			pointer('99999999999999999999'),
			pointer().replace('v1', 'v2'),
			` ${pointer()}`,
			`${pointer()}`.replace('version', 'Version'),
			`${pointer()}${'x'.repeat(1100)}`,
		];
		for (const text of bad) {
			assert.equal(parseLfsPointer(enc(text)), undefined, JSON.stringify(text.slice(0, 60)));
		}
		assert.equal(parseLfsPointer(new Uint8Array([0xff, 0xfe, 0, 1])), undefined);
	});

	it('bounds the size a pointer can have', () => {
		assert.equal(enc(pointer(0).trimEnd()).length, 125);
		assert.equal(mayBeLfsPointer(124), false);
		assert.equal(mayBeLfsPointer(125), true);
		assert.equal(mayBeLfsPointer(1024), true);
		assert.equal(mayBeLfsPointer(1025), false);
	});

	it('hashes with SHA-256', async () => {
		assert.equal(await sha256Hex(enc('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});
});

describe('file types for the workbench', () => {
	const declared = (name: string): number => {
		const source = readFileSync(new URL('../node_modules/@types/vscode/index.d.ts', import.meta.url), 'utf8');
		const block = /export enum FileType \{([\s\S]*?)\n\t\}/.exec(source)?.[1] ?? '';
		return Number(new RegExp(`${name} = (\\d+)`).exec(block)?.[1]);
	};

	it('uses the vscode.FileType values', () => {
		assert.deepEqual([declared('Unknown'), declared('File'), declared('Directory'), declared('SymbolicLink')], [0, 1, 2, 64]);
	});

	it('maps entries, combining a link with the type of its target', () => {
		const [unknown, file, directory, link] = [0, 1, 2, 64];
		assert.equal(fileTypeBits('file'), file);
		assert.equal(fileTypeBits('directory'), directory);
		assert.equal(fileTypeBits('symlink', 'file'), file | link);
		assert.equal(fileTypeBits('symlink', 'directory'), directory | link);
		assert.equal(fileTypeBits('symlink'), unknown | link, 'dangling, escaping or looping link');
		assert.equal(fileTypeBits('submodule'), unknown);
	});
});
