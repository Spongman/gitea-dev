// Gitea Web IDE: pressing "." opens the launch link rendered by extra_tabs.tmpl in a new tab.
// Must run synchronously right after the link is parsed (see docs/gitea-integration.md).
(function (window, document) {
  'use strict';

  const MARKER = 'data-gitea-dev-shortcut';
  const LINK = 'a[data-gitea-dev-launch]';
  const IGNORED_TARGETS = [
    'input', 'textarea', 'select',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]', '[role="spinbutton"]',
    '.monaco-editor', '.cm-editor', '.CodeMirror',
    'dialog', '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', '.ui.modal',
  ].join(',');
  const OPEN_DIALOGS = 'dialog[open], .ui.active.modal, .ui.active.dimmer';

  const root = document.documentElement;
  if (root.hasAttribute(MARKER)) return;
  root.setAttribute(MARKER, '');

  // Cache the URL: the link can be moved out of the document by the overflow menu.
  const initial = document.querySelector(LINK);
  const cachedHref = initial ? initial.getAttribute('href') : null;

  function launchUrl() {
    const link = document.querySelector(LINK);
    const href = link ? link.getAttribute('href') : cachedHref;
    if (!href) return null;
    let url;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return null;
    }
    return url.origin === window.location.origin ? url : null;
  }

  function eventElements(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const nodes = path.length ? path : [event.target];
    const elements = nodes.filter((node) => node && node.nodeType === 1);
    for (let el = event.target && event.target.parentElement; !path.length && el; el = el.parentElement) {
      elements.push(el);
    }
    const active = document.activeElement;
    if (active && !elements.includes(active)) elements.push(active);
    return elements;
  }

  function isIgnored(event) {
    if (document.querySelector(OPEN_DIALOGS)) return true;
    return eventElements(event).some((el) => typeof el.matches === 'function' && el.matches(IGNORED_TARGETS));
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== '.' || event.defaultPrevented || event.isComposing || event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isIgnored(event)) return;
    const url = launchUrl();
    if (!url) return;
    event.preventDefault();
    window.open(url.href, '_blank', 'noopener');
  });
})(window, document);
