// The legal pages' Markdown renderer (src/lib/markdown.tsx) and the files in legal/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, safeHref } from '../src/lib/markdown.tsx';

const values = { CONTACT_EMAIL: 'support@devswartz.com', OPERATOR_NAME: 'devswartz.com', APP_NAME: 'Notivelo' };
const render = (source: string) => renderToStaticMarkup(createElement(Markdown, { source, values }));

test('privacy.md and terms.md render with headings and no leftover placeholders or comments', () => {
  for (const [file, title] of [
    ['legal/privacy.md', 'Privacy Policy'],
    ['legal/terms.md', 'Terms of Service'],
  ]) {
    const html = render(fs.readFileSync(file, 'utf8'));
    assert.match(html, new RegExp(`<h1>${title}</h1>`));
    assert.ok((html.match(/<h2>/g) ?? []).length >= 5, `${file} has sections`);
    assert.match(html, /Last updated/);
    assert.match(html, /href="mailto:support@devswartz\.com"/);
    assert.doesNotMatch(html, /\{\{|TODO|lawyer|<!--/);
  }
  assert.match(render(fs.readFileSync('legal/privacy.md', 'utf8')), /Settings → Delete account/);
});

test('headings, lists, links, bold and italic render', () => {
  const html = render('# T\n\nHello **bold** and *it* and `c`.\n\n- a\n- b\n\n1. x\n2. y\n\n[Terms](/terms) [Web](https://example.com)');
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>it<\/em>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<ol><li>x<\/li><li>y<\/li><\/ol>/);
  assert.match(html, /href="\/terms"/);
  assert.match(html, /href="https:\/\/example.com"/);
});

test('raw HTML is shown as text, never executed', () => {
  const html = render('# Hi <script>alert(1)</script>\n\n<img src=x onerror=alert(1)> and <b>x</b>');
  assert.doesNotMatch(html, /<script|<img|<b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('unsafe link targets are not turned into links; comments are dropped', () => {
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('//evil.example'), null);
  assert.equal(safeHref('data:text/html,x'), null);
  const html = render('[x](javascript:alert(1)) <!-- secret\nnote --> done');
  assert.doesNotMatch(html, /href=|secret/);
  assert.match(html, /x/);
});
