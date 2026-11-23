import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(import.meta.dir, '..', 'src', 'console.html'), 'utf-8');

describe('console gate', () => {
  it('starts locked, so nothing is shown until a session is confirmed', () => {
    expect(html).toContain('<body class="console-locked">');
    expect(html).toContain('body.console-locked .sidebar, body.console-locked .main-content');
  });

  it('signs out into the sign-in window, never into an open console', () => {
    const logout = html.slice(html.indexOf('async function handleLogout'), html.indexOf('async function bootstrapMerchantSession'));
    expect(logout).toContain("openAuthModal('signin')");
  });

  it('has one sign-in/create-account switch line instead of two tab buttons', () => {
    expect(html).not.toContain('authTabSignIn');
    expect(html).not.toContain('authTabRegister');
    expect(html).toContain('id="authSwitch"');
  });

  it('keeps the sign-in window from showing a page scrollbar', () => {
    expect(html).toContain('.modal-overlay { padding: 16px; overflow: hidden; }');
    expect(html).toContain('.modal-card::-webkit-scrollbar { display: none; }');
  });
});

describe('landing page pop-up', () => {
  it('opens Create an account inside the pop-up instead of leaving the landing page', () => {
    const header = readFileSync(join(import.meta.dir, '..', 'src', 'partials', 'header.html'), 'utf-8');
    expect(header).toContain('data-view="register"');
    expect(header).toContain('href="/console?auth=register" data-show-view="register"');
  });
});

describe('pop-up styles', () => {
  it('keeps the hidden authenticator field hidden', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'src', 'assets', 'css', 'site.css'), 'utf-8');
    expect(css).toContain('.signin-field[hidden]');
  });
});
