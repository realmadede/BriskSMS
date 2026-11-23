import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createWebServer } from '../server';

const SRC = join(import.meta.dir, '..', 'src');

async function get(path: string): Promise<Response> {
  const server = createWebServer();
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
  } finally {
    server.close();
  }
}

describe('nexus (platform admin)', () => {
  it('is served at /nexus, kept out of search engines and never cached', async () => {
    const res = await get('/nexus');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.text()).toContain('name="robots" content="noindex');
  });

  it('is not reachable by the usual admin names', async () => {
    for (const path of ['/admin', '/admin.html', '/nexus.html', '/nexus/']) {
      const res = await get(path);
      expect(res.status === 404 || res.status === 301).toBe(true);
      if (res.status === 301) expect(res.headers.get('location')).toBe('/nexus');
    }
    expect((await get('/admin')).status).toBe(404);
    expect((await get('/nexus.html')).status).toBe(404);
  });

  it('is not linked from any public page, the header, the console or the scripts', () => {
    const files = [
      'index.html', 'developers.html', 'privacy.html', 'terms.html', 'console.html',
      'partials/header.html', 'assets/js/site.js', 'assets/js/home.js', 'assets/js/developers.js',
    ];
    for (const file of files) {
      expect(readFileSync(join(SRC, file), 'utf-8').toLowerCase()).not.toContain('nexus');
    }
    expect(readdirSync(SRC).filter((f) => /sitemap|robots/i.test(f))).toEqual([]);
  });
});
