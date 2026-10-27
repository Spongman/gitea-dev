import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Window, type Document, type Element, type HTMLElement, type KeyboardEvent } from 'happy-dom';

const SOURCE = readFileSync(
  new URL('../gitea/custom/public/assets/gitea-dev/shortcut.js', import.meta.url),
  'utf8',
);
const LINK = '<a class="item" href="/sub/assets/gitea-dev/index.html?owner=a&amp;repository=b&amp;ref=main&amp;refKind=branch" data-gitea-dev-launch>Web IDE</a>';

interface Page {
  window: Window;
  opened: string[][];
  press: (target: Element | Document, init?: Record<string, unknown>) => KeyboardEvent;
}

function page(body: string, { run = true }: { run?: boolean } = {}): Page {
  const window = new Window({ url: 'https://gitea.example/sub/a/b' });
  const opened: string[][] = [];
  (window as unknown as { open: (...args: string[]) => null }).open = (...args) => {
    opened.push(args);
    return null;
  };
  window.document.body.innerHTML = body;
  const load = () => new Function('window', 'document', SOURCE)(window, window.document);
  if (run) load();
  return {
    window,
    opened,
    press(target, init = {}) {
      const event = new window.KeyboardEvent('keydown', { key: '.', bubbles: true, cancelable: true, composed: true, ...init });
      target.dispatchEvent(event);
      return event;
    },
  };
}

describe('shortcut.js', () => {
  it('opens the launch link in a new tab on "."', () => {
    const p = page(LINK);
    const event = p.press(p.window.document.body);
    assert.deepEqual(p.opened, [[
      'https://gitea.example/sub/assets/gitea-dev/index.html?owner=a&repository=b&ref=main&refKind=branch',
      '_blank',
      'noopener',
    ]]);
    assert.equal(event.defaultPrevented, true);
  });

  it('fires from the document itself and from ordinary elements', () => {
    const p = page(`${LINK}<p id="x">text</p><button id="y">b</button>`);
    p.press(p.window.document);
    p.press(p.window.document.getElementById('x')!);
    p.press(p.window.document.getElementById('y')!);
    assert.equal(p.opened.length, 3);
  });

  it('ignores other keys', () => {
    const p = page(LINK);
    p.press(p.window.document.body, { key: ',' });
    p.press(p.window.document.body, { key: 'a' });
    assert.equal(p.opened.length, 0);
  });

  it('ignores modified keypresses', () => {
    const p = page(LINK);
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
      p.press(p.window.document.body, { [mod]: true });
    }
    assert.equal(p.opened.length, 0);
  });

  it('opens on "." typed with Shift, as on AZERTY layouts where event.key is resolved by the layout', () => {
    const p = page(LINK);
    p.press(p.window.document.body, { shiftKey: true });
    assert.equal(p.opened.length, 1);
    p.press(p.window.document.body, { shiftKey: true, ctrlKey: true });
    assert.equal(p.opened.length, 1);
  });

  it('ignores repeats, composition and already-handled events', () => {
    const p = page(LINK);
    p.press(p.window.document.body, { repeat: true });
    p.press(p.window.document.body, { isComposing: true });
    p.window.document.addEventListener('keydown', (e) => e.preventDefault(), { capture: true });
    p.press(p.window.document.body);
    assert.equal(p.opened.length, 0);
  });

  it('ignores keys typed in inputs, textareas, selects and contenteditable', () => {
    const p = page(`${LINK}
      <input id="i"><textarea id="t"></textarea><select id="s"><option>o</option></select>
      <div id="c" contenteditable="true"><span id="cs">x</span></div>
      <div id="c2" contenteditable=""><span id="c2s">x</span></div>
      <div id="r" role="textbox"></div><div id="cb" role="combobox"></div>`);
    for (const id of ['i', 't', 's', 'c', 'cs', 'c2', 'c2s', 'r', 'cb']) {
      p.press(p.window.document.getElementById(id)!);
    }
    assert.equal(p.opened.length, 0);
  });

  it('does not ignore contenteditable="false"', () => {
    const p = page(`${LINK}<div id="c" contenteditable="false">x</div>`);
    p.press(p.window.document.getElementById('c')!);
    assert.equal(p.opened.length, 1);
  });

  it('ignores keys inside code editors', () => {
    const p = page(`${LINK}
      <div class="monaco-editor"><div id="m"></div></div>
      <div class="cm-editor"><div id="cm"></div></div>
      <div class="CodeMirror"><div id="old"></div></div>`);
    for (const id of ['m', 'cm', 'old']) p.press(p.window.document.getElementById(id)!);
    assert.equal(p.opened.length, 0);
  });

  it('ignores keys inside dialogs and modals', () => {
    const p = page(`${LINK}
      <dialog id="d"><button id="db">b</button></dialog>
      <div role="dialog"><button id="rb">b</button></div>
      <div aria-modal="true"><button id="ab">b</button></div>
      <div class="ui modal"><button id="mb">b</button></div>`);
    for (const id of ['d', 'db', 'rb', 'ab', 'mb']) p.press(p.window.document.getElementById(id)!);
    assert.equal(p.opened.length, 0);
  });

  it('ignores keys while a dialog is open even when focus is elsewhere', () => {
    for (const dialog of ['<dialog open></dialog>', '<div class="ui active modal"></div>', '<div class="ui active dimmer"></div>']) {
      const p = page(`${LINK}${dialog}`);
      p.press(p.window.document.body);
      assert.equal(p.opened.length, 0, dialog);
    }
  });

  it('ignores keys when focus is in an input but the event target is the body', () => {
    const p = page(`${LINK}<input id="i">`);
    (p.window.document.getElementById('i') as HTMLElement).focus();
    p.press(p.window.document.body);
    assert.equal(p.opened.length, 0);
  });

  it('does nothing without a launch link (non-repository pages)', () => {
    const p = page('<p>no link</p>');
    p.press(p.window.document.body);
    assert.equal(p.opened.length, 0);
  });

  it('keeps working when the link was moved out of the document after load', () => {
    const p = page(LINK);
    p.window.document.querySelector('a')!.remove();
    p.press(p.window.document.body);
    assert.equal(p.opened.length, 1);
  });

  it('refuses a link to another origin or a non-http scheme', () => {
    for (const href of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', 'data:text/html,x']) {
      const p = page(`<a href="${href}" data-gitea-dev-launch>x</a>`);
      p.press(p.window.document.body);
      assert.equal(p.opened.length, 0, href);
    }
  });

  it('installs only once per document', () => {
    const p = page(LINK);
    new Function('window', 'document', SOURCE)(p.window, p.window.document);
    p.press(p.window.document.body);
    assert.equal(p.opened.length, 1);
  });

  it('is plain ASCII and uses no eval or inline-script patterns', () => {
    assert.doesNotMatch(SOURCE, /[^\x00-\x7f]/);
    assert.doesNotMatch(SOURCE, /\beval\s*\(|new Function|innerHTML|document\.write/);
  });
});
