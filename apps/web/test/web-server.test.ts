import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { AddressInfo } from 'node:net';
import { Server, get as httpGet } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { createWebServer } from '../server';

function rawHttpGetStatus(port: number, rawPath: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path: rawPath }, (res) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.on('error', reject);
  });
}

describe('Web Server & Portal Hardening', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createWebServer();
    await new Promise<void>((resolveReady) => {
      server.listen(0, '127.0.0.1', () => resolveReady());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClosed, rejectClosed) => {
      server.close((err) => (err ? rejectClosed(err) : resolveClosed()));
    });
  });

  it('serves landing, developers, legal, console, and health with security headers', async () => {
    for (const path of ['/', '/developers', '/getting-started', '/privacy', '/terms', '/console', '/health']) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    }
  });

  it('stitches the shared header into both public pages and serves their split CSS/JS', async () => {
    const pages: Array<[string, string]> = [['/', 'home'], ['/developers', 'developers']];
    for (const [path, name] of pages) {
      const html = await (await fetch(`${baseUrl}${path}`)).text();
      expect(html).not.toContain('<!-- @header -->');
      expect(html).toContain('id="siteHeader"');
      expect(html).toContain('id="mobileNavDrawer"');
      // Relative, so the same files also render from a static preview (e.g. VS Code Live Server)
      expect(html).toContain('href="assets/css/site.css"');
      expect(html).toContain(`href="assets/css/${name}.css"`);
      expect(html).toContain('src="assets/js/site.js"');
      expect(html).toContain(`src="assets/js/${name}.js"`);
    }
    for (const path of ['/privacy', '/terms']) {
      const html = await (await fetch(`${baseUrl}${path}`)).text();
      expect(html).not.toContain('<!-- @header -->');
      expect(html).toContain('id="siteHeader"');
      expect(html).toContain('href="assets/css/site.css"');
      expect(html).toContain('href="assets/css/legal.css"');
      expect(html).toContain('src="assets/js/site.js"');
    }
    expect((await fetch(`${baseUrl}/assets/css/legal.css`)).status).toBe(200);
    // Every public page gets the sign-in pop-up; its links still reach the console without JavaScript
    for (const path of ['/', '/developers', '/privacy', '/terms']) {
      const html = await (await fetch(`${baseUrl}${path}`)).text();
      expect(html).toContain('<dialog class="signin-dialog" id="signinDialog"');
      expect(html).toContain('<a class="site-signin" href="/console" data-signin>');
    }
    for (const name of ['site', 'home', 'developers']) {
      const css = await fetch(`${baseUrl}/assets/css/${name}.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get('content-type')).toContain('text/css');
      expect(css.headers.get('cache-control')).toBe('no-cache');
      const js = await fetch(`${baseUrl}/assets/js/${name}.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toContain('application/javascript');
      expect(js.headers.get('cache-control')).toBe('no-cache');
    }
    // The partial is only ever served inside a page, never on its own
    const port = (server.address() as AddressInfo).port;
    expect(await rawHttpGetStatus(port, '/partials/header.html')).toBe(404);
    expect(await rawHttpGetStatus(port, '/assets/..%2Fpartials%2Fheader.html')).toBe(403);
  });

  it('serves the setup guide with the shared header, its own CSS and every step', async () => {
    const html = await (await fetch(`${baseUrl}/getting-started`)).text();
    expect(html).not.toContain('<!-- @header -->');
    expect(html).toContain('id="siteHeader"');
    expect(html).toContain('<dialog class="signin-dialog" id="signinDialog"');
    expect(html).toContain('href="assets/css/getting-started.css"');
    expect(html).toContain('<h1>');
    expect((html.match(/<ol class="gs-steps">[\s\S]*?<\/ol>\s*<\/div>/)?.[0].match(/<h3>/g) ?? []).length).toBeGreaterThanOrEqual(7);
    expect((await fetch(`${baseUrl}/getting-started.html`)).status).toBe(200);
    // The motion script, the official Google Play badge and a reduced-motion fallback ship with the page
    expect(html).toContain('src="assets/js/getting-started.js"');
    expect(html).toContain('play.google.com/store/apps/details?id=tz.co.brisksms');
    expect(html.toLowerCase()).not.toContain('coming soon');
    const js = await fetch(`${baseUrl}/assets/js/getting-started.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('application/javascript');
    const badge = await fetch(`${baseUrl}/assets/brand/google-play-badge.svg`);
    expect(badge.status).toBe(200);
    expect(badge.headers.get('content-type')).toContain('image/svg+xml');
    expect(await (await fetch(`${baseUrl}/assets/css/getting-started.css`)).text()).toContain('prefers-reduced-motion');
    const css = await fetch(`${baseUrl}/assets/css/getting-started.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    // Reachable from the shared header and from the landing footer
    for (const path of ['/', '/getting-started']) {
      expect(await (await fetch(`${baseUrl}${path}`)).text()).toContain('href="/getting-started"');
    }
  });

  it('redirects trailing-slash URLs to the slash-less page without allowing an open redirect', async () => {
    const res = await fetch(`${baseUrl}/developers/?tab=api`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/developers?tab=api');

    // "/.//evil.example/" normalises to the path "//evil.example/"; it must stay on this host
    const port = (server.address() as AddressInfo).port;
    const location = await new Promise<string | undefined>((resolveLocation, reject) => {
      const req = httpGet({ host: '127.0.0.1', port, path: '/.//evil.example/' }, (r) => {
        r.resume();
        resolveLocation(r.headers.location);
      });
      req.on('error', reject);
    });
    expect(location).toBe('/evil.example');
  });

  it('blocks /assets/ directory traversal attempts and malformed encodings', async () => {
    expect(await rawHttpGetStatus((server.address() as AddressInfo).port, '/assets/brand%2F..%2F..%2Fserver.ts')).toBe(403);
    expect([403, 404]).toContain(
      await rawHttpGetStatus((server.address() as AddressInfo).port, '/assets/%2e%2e/server.ts')
    );
    expect([403, 404]).toContain(
      await rawHttpGetStatus((server.address() as AddressInfo).port, '/assets/../package.json')
    );
    expect(await rawHttpGetStatus((server.address() as AddressInfo).port, '/assets/%E0%A4%A')).toBe(400);

    const fav = await fetch(`${baseUrl}/assets/brand/favicon.svg`);
    expect(fav.status).toBe(200);
    expect(fav.headers.get('content-type')).toContain('image/svg+xml');
  });

  it('enforces real auth/CSV/TZS logic without XSS or fabricated demo fallbacks in console.html', () => {
    const consolePath = resolve(import.meta.dir, '../src/console.html');
    const html = readFileSync(consolePath, 'utf-8');

    expect(html).toContain('function escapeHtml(');
    expect(html).toContain('function formatMinorTzs(');
    expect(html).toContain('organizationName:');
    expect(html).toContain('parseContactsFromSpreadsheetText');
    expect(html).not.toContain('Demo Merchant');
    expect(html).not.toContain('merchant-a@brisksms.app');
    expect(html).not.toContain('Password123!');
    expect(html).not.toContain("verifyPaymentAction('${r.id}'");
    expect(html).not.toContain("to: '+255712345678'");
    expect(html).not.toContain('BRK-8821');
    expect(html).not.toContain('value="0754123456"');
    expect(html).not.toContain('value="10000"');
  });

  it('parses multi-line RFC-4180 CSVs, deduplicates phones, and blocks XML DOCTYPE/ENTITY & malformed XML', () => {
    const consolePath = resolve(import.meta.dir, '../src/console.html');
    const html = readFileSync(consolePath, 'utf-8');

    const startMarker = 'const MAX_SPREADSHEET_BYTES =';
    const endMarker = 'async function previewCsvUpload(input)';
    const startIdx = html.indexOf(startMarker);
    const endIdx = html.indexOf(endMarker);
    expect(startIdx).toBeGreaterThan(0);
    expect(endIdx).toBeGreaterThan(startIdx);

    const snippet = html.slice(startIdx, endIdx);
    const sandbox: any = {
      window: {},
      DOMParser: class {
        parseFromString(xmlText: string) {
          if (xmlText.includes('<broken')) {
            return {
              querySelector: (sel: string) => (sel === 'parsererror' ? { textContent: 'Syntax error' } : null),
              querySelectorAll: () => [],
            };
          }
          return {
            querySelector: () => null,
            querySelectorAll: () => [
              { querySelectorAll: () => [{ textContent: 'Phone' }, { textContent: 'Name' }] },
              { querySelectorAll: () => [{ textContent: '0754 111 222' }, { textContent: 'Asha' }, { textContent: '5000' }, { textContent: 'INV-1' }] },
            ],
          };
        }
      },
    };
    vm.runInNewContext(
      `${snippet}; this.__exports = { parseContactsFromSpreadsheetText, normalizeTzPhoneClient, parseCsvRowsRfc4180 };`,
      sandbox,
    );

    const { parseContactsFromSpreadsheetText } = sandbox.__exports;
    const multilineCsv = [
      'Phone,Name,Amount,Invoice',
      '"0754 123 456","Juma ""Mwamba""",15000,"INV-100',
      'Line 2"',
      '+255754123456,Duplicate Juma,15000,INV-100',
      'not-a-phone,Invalid User,1000,INV-999',
      '255655112233,Neema,20000,INV-101',
    ].join('\n');

    const contacts = parseContactsFromSpreadsheetText(multilineCsv);
    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toEqual({
      phone: '+255754123456',
      name: 'Juma "Mwamba"',
      amount: '15000',
      invoice: 'INV-100\nLine 2',
    });
    expect(contacts[1].phone).toBe('+255655112233');
    expect(sandbox.window.lastSpreadsheetParseStats.skippedDuplicates).toBe(1);
    expect(sandbox.window.lastSpreadsheetParseStats.skippedInvalid).toBe(1);

    expect(() =>
      parseContactsFromSpreadsheetText('<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Workbook/>'),
    ).toThrow(/prohibited/i);
    expect(() => parseContactsFromSpreadsheetText('<Workbook><broken></Workbook>')).toThrow(/Malformed/i);

    const xmlContacts = parseContactsFromSpreadsheetText('<Workbook><Worksheet><Table><Row><Cell><Data>Phone</Data></Cell></Row></Table></Worksheet></Workbook>');
    expect(xmlContacts).toHaveLength(1);
    expect(xmlContacts[0].phone).toBe('+255754111222');
  });

  it('keeps developers.html honest (no nonexistent SDK packages) and links both footers to the legal pages', () => {
    const devPath = resolve(import.meta.dir, '../src/developers.html');
    const devHtml = readFileSync(devPath, 'utf-8');
    expect(devHtml).not.toContain('@brisksms/sdk');
    expect(devHtml).not.toContain('pip install brisksms');
    expect(devHtml).not.toContain('github.com/brisksms/sdk-go');
    expect(devHtml).not.toContain('composer require brisksms/sdk');
    expect(devHtml).not.toContain('BriskSMS.Sdk');

    const indexHtml = readFileSync(resolve(import.meta.dir, '../src/index.html'), 'utf-8');
    for (const html of [indexHtml, devHtml]) {
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/terms"');
    }
  });

  it('states the Bank of Tanzania non-licensing disclaimer in the terms and the landing footer (COMPLIANCE_AND_FEASIBILITY.md section 3.1)', () => {
    const disclaimer =
      'BriskSMS is an independent software automation platform and is not a bank, electronic money issuer, or payment service provider licensed by the Bank of Tanzania.';
    const termsHtml = readFileSync(resolve(import.meta.dir, '../src/terms.html'), 'utf-8');
    const notABank = termsHtml.slice(termsHtml.indexOf('id="not-a-bank"'), termsHtml.indexOf('id="the-service"'));
    expect(notABank).toContain(disclaimer);
    const indexHtml = readFileSync(resolve(import.meta.dir, '../src/index.html'), 'utf-8');
    expect(indexHtml.slice(indexHtml.indexOf('class="footer-bottom"'))).toContain(disclaimer);
  });

  it('parses every page script without a syntax error (a duplicate declaration once stopped home.js and left the scroll reveals faded)', () => {
    const jsDir = resolve(import.meta.dir, '../src/assets/js');
    const files = readdirSync(jsDir).filter((name) => name.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(() => new vm.Script(readFileSync(resolve(jsDir, name), 'utf-8'), { filename: name })).not.toThrow();
    }
  });
  it('parses the console inline script without a syntax error (a stray quote once stopped it and every button went dead)', () => {
    const html = readFileSync(resolve(import.meta.dir, '../src/console.html'), 'utf-8');
    const scripts = [...html.matchAll(/<script(?![^>]*\ssrc)[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, code] of scripts) {
      expect(() => new vm.Script(code!, { filename: 'console.html' })).not.toThrow();
    }
  });

  it('keeps the developers page usable on phones: every inline multi-column grid collapses and every table cell is labelled', () => {
    const html = readFileSync(resolve(import.meta.dir, '../src/developers.html'), 'utf-8');
    const inlineGrids = html.match(/<div[^>]*style="[^"]*grid-template-columns: (?:repeat\(\d, 1fr\)|1fr 1fr)[^"]*"/g) ?? [];
    expect(inlineGrids.length).toBeGreaterThan(0);
    for (const grid of inlineGrids) expect(grid).toContain('resp-grid');
    for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
      for (const cell of table.match(/<td[^>]*>/g) ?? []) expect(cell).toContain('data-label=');
    }
  });
});
