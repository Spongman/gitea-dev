import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterQueryResponse, galleryExtensionId, galleryProductConfiguration } from '../packages/editor-host/src/gallery.js';

test('product configuration points the workbench directly at the gallery', () => {
  assert.deepEqual(galleryProductConfiguration('https://open-vsx.org'), {
    serviceUrl: 'https://open-vsx.org/vscode/gallery',
    itemUrl: 'https://open-vsx.org/vscode/item',
    resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
    extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
  });
});

test('extension ids are read from every gallery route the workbench uses', () => {
  const id = (url: string, base = 'https://open-vsx.org') => galleryExtensionId(new URL(url), base);
  assert.equal(id('https://open-vsx.org/vscode/gallery/extensionquery'), null);
  assert.equal(id('https://open-vsx.org/vscode/gallery/Esbenp/prettier-vscode/latest'), 'esbenp.prettier-vscode');
  assert.equal(id('https://open-vsx.org/vscode/gallery/vscode/esbenp/prettier-vscode/latest'), 'esbenp.prettier-vscode');
  assert.equal(id('https://open-vsx.org/vscode/unpkg/esbenp/prettier-vscode/12.4.0/extension/package.json'), 'esbenp.prettier-vscode');
  assert.equal(id('https://open-vsx.org/vscode/asset/esbenp/prettier-vscode/12.4.0/Microsoft.VisualStudio.Services.Icons.Default'), 'esbenp.prettier-vscode');
  assert.equal(id('https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png'), 'esbenp.prettier-vscode');
  assert.equal(id('https://open-vsx.org/vscode/item?itemName=Esbenp.Prettier-VSCode'), 'esbenp.prettier-vscode');
  assert.equal(id('https://open-vsx.org/api/-/public-key/0123abcd'), null);
  // Other /api/-/ routes (search, query, namespace) list extensions without naming one.
  for (const path of ['search?query=x', 'query', 'namespace/evil', 'public-key', 'public-key/a/b']) {
    assert.equal(id(`https://open-vsx.org/api/-/${path}`), undefined, path);
  }
  assert.equal(id('https://openvsx.eclipsecontent.org/esbenp/prettier-vscode/12.4.0/icon.png'), 'esbenp.prettier-vscode');
  assert.equal(id('https://open-vsx.org/elsewhere'), undefined);
  assert.equal(id('https://host.example/gallery/vscode/unpkg/a/b/1/extension/x', 'https://host.example/gallery'), 'a.b');
  assert.equal(id('https://host.example/other/vscode/unpkg/a/b/1/extension/x', 'https://host.example/gallery'), undefined);
  assert.equal(id('https://open-vsx.org/vscode/unpkg/%E0%A4%A/b/1/extension/x'), undefined);
});

test('query responses keep only allowlisted extensions and lower the total count', () => {
  const extension = (publisher: string, name: string) => ({ extensionName: name, publisher: { publisherName: publisher } });
  const body = { results: [{
    extensions: [extension('Esbenp', 'prettier-vscode'), extension('evil', 'stealer'), extension('redhat', 'vscode-yaml')],
    resultMetadata: [{ metadataType: 'ResultCount', metadataItems: [{ name: 'TotalCount', count: 30 }] }],
  }] };
  const filtered = filterQueryResponse(body, new Set(['esbenp.prettier-vscode', 'redhat.vscode-yaml']));
  assert.deepEqual(filtered.results?.[0].extensions?.map(e => e.extensionName), ['prettier-vscode', 'vscode-yaml']);
  assert.equal(filtered.results?.[0].resultMetadata?.[0].metadataItems?.[0].count, 29);
});
