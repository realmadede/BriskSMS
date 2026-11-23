import { HttpException } from '../../core/http.js';

export interface AppRelease {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  sha256: string;
  notes: string;
}

export interface AppReleaseCheck {
  updateAvailable: boolean;
  required: boolean;
  release: AppRelease | null;
}

const SHA256_REGEX = /^[0-9a-f]{64}$/i;
const MAX_NOTES_LENGTH = 1000;

function readPositiveInt(raw: string | undefined, name: string): number {
  const value = Number((raw ?? '').trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Reads the published direct-flavor APK release from the environment.
 * Returns null when no release is published. A partly configured or malformed release throws,
 * so the app is never pointed at a bad download.
 */
export function readPublishedRelease(
  env: NodeJS.ProcessEnv = process.env,
): { release: AppRelease; minSupportedVersionCode: number } | null {
  if (!env.APP_RELEASE_VERSION_CODE?.trim()) return null;

  const versionCode = readPositiveInt(env.APP_RELEASE_VERSION_CODE, 'APP_RELEASE_VERSION_CODE');
  const versionName = (env.APP_RELEASE_VERSION_NAME ?? '').trim();
  if (!versionName) throw new Error('APP_RELEASE_VERSION_NAME is required');

  let parsedUrl: URL;
  try {
    parsedUrl = new URL((env.APP_RELEASE_APK_URL ?? '').trim());
  } catch {
    throw new Error('APP_RELEASE_APK_URL must be an absolute URL');
  }
  if (parsedUrl.protocol !== 'https:') throw new Error('APP_RELEASE_APK_URL must use https');

  const sha256 = (env.APP_RELEASE_APK_SHA256 ?? '').trim().toLowerCase();
  if (!SHA256_REGEX.test(sha256)) throw new Error('APP_RELEASE_APK_SHA256 must be 64 hex characters');

  const notes = (env.APP_RELEASE_NOTES ?? '').trim();
  if (notes.length > MAX_NOTES_LENGTH) {
    throw new Error(`APP_RELEASE_NOTES must be at most ${MAX_NOTES_LENGTH} characters`);
  }

  const minSupportedVersionCode = env.APP_RELEASE_MIN_SUPPORTED_VERSION_CODE?.trim()
    ? readPositiveInt(env.APP_RELEASE_MIN_SUPPORTED_VERSION_CODE, 'APP_RELEASE_MIN_SUPPORTED_VERSION_CODE')
    : 1;
  if (minSupportedVersionCode > versionCode) {
    throw new Error('APP_RELEASE_MIN_SUPPORTED_VERSION_CODE cannot exceed APP_RELEASE_VERSION_CODE');
  }

  return {
    release: { versionCode, versionName, apkUrl: parsedUrl.toString(), sha256, notes },
    minSupportedVersionCode,
  };
}

export function checkForUpdate(currentVersionCode: number, env: NodeJS.ProcessEnv = process.env): AppReleaseCheck {
  let published: ReturnType<typeof readPublishedRelease>;
  try {
    published = readPublishedRelease(env);
  } catch (err) {
    console.error('[AppRelease] Invalid release configuration:', err instanceof Error ? err.message : err);
    throw new HttpException(503, 'APP_RELEASE_CONFIG_INVALID', 'Release information is temporarily unavailable.');
  }

  if (!published || published.release.versionCode <= currentVersionCode) {
    return { updateAvailable: false, required: false, release: null };
  }
  return {
    updateAvailable: true,
    required: currentVersionCode < published.minSupportedVersionCode,
    release: published.release,
  };
}
