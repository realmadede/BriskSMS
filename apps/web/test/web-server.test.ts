import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { AddressInfo } from 'node:net';
import { Server, get as httpGet } from 'node:http';
import { readFileSync } from 'node:fs';
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

  it('serves landing, developers, console, and health with security headers', async () => {
    for (const path of ['/', '/developers', '/console', '/health']) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    }
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
    expect(html).not.toContain('merchant-a@brisksms.co.tz');
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

  it('keeps developers.html honest (no nonexistent SDK packages) and resolves index.html footer anchors', () => {
    const devPath = resolve(import.meta.dir, '../src/developers.html');
    const devHtml = readFileSync(devPath, 'utf-8');
    expect(devHtml).not.toContain('@brisksms/sdk');
    expect(devHtml).not.toContain('pip install brisksms');
    expect(devHtml).not.toContain('github.com/brisksms/sdk-go');
    expect(devHtml).not.toContain('composer require brisksms/sdk');
    expect(devHtml).not.toContain('BriskSMS.Sdk');

    const indexPath = resolve(import.meta.dir, '../src/index.html');
    const indexHtml = readFileSync(indexPath, 'utf-8');
    expect(indexHtml).toContain('id="privacy"');
    expect(indexHtml).toContain('id="terms"');
  });
});
