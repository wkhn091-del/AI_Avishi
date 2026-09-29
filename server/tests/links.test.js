// Link input handling, SSRF address checks and preview text cleanup (no network needed).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dropIfRepeated, stripSiteName } from '../src/services/links/linkPreview.js';
import { checkHost, isPublicAddress, normalizeUserUrl } from '../src/services/links/urlSafety.js';

describe('normalizeUserUrl', () => {
  const accepted = [
    ['example.com', 'https://example.com/'],
    ['HTTP://Example.COM/Path?q=1#top', 'http://example.com/Path?q=1#top'],
    ['//cdn.example.com/lib.js', 'https://cdn.example.com/lib.js'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['192.168.1.10', 'http://192.168.1.10/'],
    ['[::1]:5173', 'http://[::1]:5173/'],
    ['https://user:secret@github.com/x', 'https://github.com/x'],
  ];
  for (const [input, expected] of accepted) {
    test(`"${input}" → ${expected}`, () => assert.equal(normalizeUserUrl(input), expected));
  }

  for (const input of ['', '   ', 'mailto:me@example.com', 'javascript:alert(1)', 'ftp://example.com/file', 'notes']) {
    test(`rejects "${input}"`, () => assert.throws(() => normalizeUserUrl(input), { status: 400 }));
  }
});

describe('address checks (SSRF guard)', () => {
  test('public addresses pass', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  });

  test('loopback, private, link-local and cloud metadata addresses are blocked', () => {
    const blocked = ['127.0.0.1', '10.0.0.8', '172.16.4.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'];
    for (const address of blocked) assert.equal(isPublicAddress(address), false, address);
  });

  test('localhost resolves to a private address', async () => {
    assert.equal(await checkHost('localhost'), 'private');
  });
});

describe('preview text cleanup', () => {
  test('removes the site name from titles', () => {
    assert.equal(stripSiteName('GitHub - expressjs/express: Fast web framework', 'GitHub'), 'expressjs/express: Fast web framework');
    assert.equal(stripSiteName('font-stretch - CSS | MDN', 'MDN'), 'font-stretch - CSS');
    assert.equal(stripSiteName('כנרת – ויקיפדיה', 'ויקיפדיה'), 'כנרת');
    assert.equal(stripSiteName('YouTube', 'YouTube'), 'YouTube');
  });

  test('drops a description that repeats the title', () => {
    const title = 'expressjs/express: Fast, unopinionated, minimalist web framework for node.';
    assert.equal(dropIfRepeated('Fast, unopinionated, minimalist web framework for node. - expressjs/express', title), null);
    assert.equal(dropIfRepeated('Python HTTP for Humans.', 'requests'), 'Python HTTP for Humans.');
  });
});
