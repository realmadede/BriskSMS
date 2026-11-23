import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createApp } from '../src/app.js';
import { checkForUpdate, readPublishedRelease } from '../src/modules/app-release/app-release.service.js';
import { HttpException } from '../src/core/http.js';

const SHA = 'a'.repeat(64);
const published = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  APP_RELEASE_VERSION_CODE: '5',
  APP_RELEASE_VERSION_NAME: '1.4.0',
  APP_RELEASE_APK_URL: 'https://downloads.brisksms.app/brisksms-direct-1.4.0.apk',
  APP_RELEASE_APK_SHA256: SHA.toUpperCase(),
  APP_RELEASE_NOTES: 'Faster sync',
  ...over,
});

describe('App release check (direct APK self-update)', () => {
  const originalError = console.error;
  beforeEach(() => {
    console.error = () => {};
  });
  afterEach(() => {
    console.error = originalError;
  });

  it('reports no release when none is published', () => {
    assert.deepEqual(checkForUpdate(1, {}), { updateAvailable: false, required: false, release: null });
  });

  it('offers a newer release with a lower-cased checksum', () => {
    const res = checkForUpdate(4, published());
    assert.equal(res.updateAvailable, true);
    assert.equal(res.required, false);
    assert.equal(res.release?.versionCode, 5);
    assert.equal(res.release?.sha256, SHA);
  });

  it('offers nothing when the phone is on the published version or newer', () => {
    assert.equal(checkForUpdate(5, published()).updateAvailable, false);
    assert.equal(checkForUpdate(9, published()).release, null);
  });

  it('marks the update required below the minimum supported version', () => {
    const env = published({ APP_RELEASE_MIN_SUPPORTED_VERSION_CODE: '3' });
    assert.equal(checkForUpdate(2, env).required, true);
    assert.equal(checkForUpdate(3, env).required, false);
  });

  it('fails closed on a partly configured or unsafe release', () => {
    const bad: Array<Record<string, string>> = [
      { APP_RELEASE_VERSION_NAME: '' },
      { APP_RELEASE_APK_URL: 'http://downloads.brisksms.app/a.apk' },
      { APP_RELEASE_APK_URL: 'not a url' },
      { APP_RELEASE_APK_SHA256: 'abc' },
      { APP_RELEASE_VERSION_CODE: '0' },
      { APP_RELEASE_MIN_SUPPORTED_VERSION_CODE: '9' },
      { APP_RELEASE_NOTES: 'x'.repeat(1001) },
    ];
    for (const over of bad) {
      assert.throws(() => readPublishedRelease(published(over)), Error, JSON.stringify(over));
      assert.throws(
        () => checkForUpdate(1, published(over)),
        (err: unknown) =>
          err instanceof HttpException && err.statusCode === 503 && err.code === 'APP_RELEASE_CONFIG_INVALID',
      );
    }
  });
});

describe('GET /v1/app/releases/latest', () => {
  const router = createApp();
  const saved = { ...process.env };

  beforeEach(() => {
    for (const [k, v] of Object.entries(published())) process.env[k] = v;
  });
  afterEach(() => {
    for (const k of Object.keys(published())) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function get(path: string): Promise<{ statusCode: number; json: any }> {
    const req = new IncomingMessage(new Socket());
    req.method = 'GET';
    req.url = path;
    const res = new ServerResponse(req);
    let captured = '';
    let statusCode = 200;
    res.setHeader = () => res;
    res.writeHead = (code: number) => {
      statusCode = code;
      return res;
    };
    res.end = (chunk?: any) => {
      if (chunk) captured += chunk.toString();
      return res;
    };
    req.push(null);
    await router.handle(req, res);
    return { statusCode, json: captured ? JSON.parse(captured) : null };
  }

  it('is public and returns the release for an older version', async () => {
    const { statusCode, json } = await get('/v1/app/releases/latest?versionCode=1');
    assert.equal(statusCode, 200);
    assert.equal(json.data.updateAvailable, true);
    assert.equal(json.data.release.versionName, '1.4.0');
  });

  it('rejects a missing or malformed versionCode', async () => {
    for (const q of ['', '?versionCode=abc', '?versionCode=0', '?versionCode=-3', '?versionCode=1.5']) {
      const { statusCode, json } = await get(`/v1/app/releases/latest${q}`);
      assert.equal(statusCode, 400, q);
      assert.equal(json.error.code, 'INVALID_VERSION_CODE');
    }
  });
});
