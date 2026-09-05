// Tests the setup page's inline <script> (renderConfigurePage) by extracting and
// running it in a node:vm sandbox with a stub document. Verifies install-URL
// encoding for RD/TorBox and the TorBox uncached-download opt-in.
import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { renderConfigurePage } from '../src/configure.js';

// Execute the page's inline <script> in a vm sandbox with a minimal stub document.
function makeElement(tag: string) {
  return {
    tagName: tag, className: '', textContent: '', type: '', value: '',
    style: {}, events: {}, children: [] as any[],
    addEventListener(event: string, callback: Function) { this.events[event] = callback; },
    appendChild(child: any) { this.children.push(child); return child; },
    setAttribute() {},
  };
}
function page() {
  const nodes = new Map<string, any>();
  const document = {
    createElement: (tag: string) => makeElement(tag),
    getElementById(id: string) {
      if (!nodes.has(id)) nodes.set(id, { ...makeElement('div'), hidden: false });
      return nodes.get(id);
    },
  };
  const html = renderConfigurePage('http://localhost:7000');
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], { document });
  return { html, get: document.getElementById };
}

it('lets users install TorBox with its own token while preserving existing RD URLs', () => {
  const p = page();
  expect(p.html).toContain('<option value="torbox">TorBox</option>');
  p.get('provider').value = 'realdebrid';
  p.get('token').value = 'example-key';
  p.get('go').events.click();
  expect(p.get('url').href).toBe('http://localhost:7000/example-key/manifest.json');
  p.get('provider').value = 'torbox';
  p.get('go').events.click();
  expect(p.get('url').href).toBe('http://localhost:7000/torbox%3Aexample-key/manifest.json');
});

it('hides a stale install link when the user changes provider', () => {
  const p = page();
  p.get('token').value = 'example-key';
  p.get('go').events.click();
  p.get('provider').events.change();
  expect(p.get('result').style.display).toBe('none');
});

it('encodes uncached downloads only when explicitly enabled for TorBox', () => {
  const p = page();
  p.get('provider').value = 'torbox';
  p.get('token').value = 'example-key';
  p.get('uncached').checked = true;
  p.get('go').events.click();
  expect(p.get('url').href).toBe('http://localhost:7000/torbox-download%3Aexample-key/manifest.json');
  p.get('uncached').events.change();
  expect(p.get('result').style.display).toBe('none');
  p.get('provider').value = 'realdebrid';
  p.get('go').events.click();
  expect(p.get('url').href).toBe('http://localhost:7000/example-key/manifest.json');
});

it('encodes languages added via the picker into the credential in priority order', () => {
  const p = page();
  p.get('provider').value = 'torbox';
  p.get('token').value = 'example-key';
  p.get('uncached').checked = true;
  p.get('langs').value = 'hindi';
  p.get('lang-add').events.click();
  p.get('langs').value = 'tamil';
  p.get('lang-add').events.click();
  p.get('go').events.click();
  expect(p.get('url').href).toBe('http://localhost:7000/torbox-download%3Aexample-key~hindi%2Ctamil/manifest.json');
});

it('ignores duplicate language picks and supports removing chips', () => {
  const p = page();
  p.get('provider').value = 'torbox';
  p.get('token').value = 'example-key';
  p.get('langs').value = 'hindi';
  p.get('lang-add').events.click();
  p.get('langs').value = 'hindi'; // duplicate: must not add twice
  p.get('lang-add').events.click();
  p.get('go').events.click();
  expect(p.get('url').href).toBe('http://localhost:7000/torbox%3Aexample-key~hindi/manifest.json');
  // Remove the chip by clicking its × button (last child of the chip element).
  const chip = p.get('lang-chips').children[0];
  chip.children[chip.children.length - 1].events.click();
  p.get('go').events.click();
  expect(p.get('url').href).toBe('http://localhost:7000/torbox%3Aexample-key/manifest.json');
});

it('offers the canonical language list as select options', () => {
  const p = page();
  expect(p.html).toContain('<select id="langs">');
  expect(p.html).toMatch(/<option value="hindi">Hindi<\/option>/);
  expect(p.html).toMatch(/<option value="malayalam">Malayalam<\/option>/);
  expect(p.html).toContain('Choose a language');
});
