/**
 * Tests for shouldAutoReloadChunkFailure — the guard that decides whether a
 * chunk-load failure should force a one-time full reload. The critical
 * invariant: NEVER auto-reload on the Tauri desktop / static desktop host
 * (:3070, :4173), where `vite build --watch` rewrites dist under the webview
 * and a reload would yank the user's session on every fleet edit.
 *
 * Run with: npx vitest run libs/generic/sync/src/lazy-with-retry.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  CHUNK_LOAD_ERROR_RE,
  isChunkLoadError,
  shouldAutoReloadChunkFailure,
} from './lazy-with-retry';

describe('isChunkLoadError (retry gate — must match EVERY engine, esp. WebKit)', () => {
  it('matches the WebKit/WebKitGTK phrasing the packaged Tauri desktop actually throws', () => {
    // WI-2902 regression: the OLD retry regex matched only the webpack phrasings,
    // so this exact message — the one the packaged desktop throws — slipped
    // through un-retried and escalated to the fatal route error boundary.
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(CHUNK_LOAD_ERROR_RE.test('Importing a module script failed.')).toBe(true);
  });

  it('matches every browser engine + webpack phrasing of a chunk/dynamic-import failure', () => {
    for (const msg of [
      'Importing a module script failed.', // WebKit (Tauri webview)
      'Failed to fetch dynamically imported module: http://x/chunk-abc.js', // Chromium
      'error loading dynamically imported module', // Firefox
      'Loading chunk 42 failed.', // webpack
      'Failed to load chunk vendors', // webpack
      'Failed to fetch chunk main', // webpack
    ]) {
      expect(isChunkLoadError(new Error(msg))).toBe(true);
    }
  });

  it('matches a ChunkLoadError by name even when the message does not', () => {
    const e = new Error('anything at all');
    e.name = 'ChunkLoadError';
    expect(isChunkLoadError(e)).toBe(true);
  });

  it('does NOT match an ordinary render/logic bug (never retried, never reloaded)', () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(new Error('Something went wrong'))).toBe(false);
  });

  it('tolerates non-Error throwables', () => {
    expect(isChunkLoadError('Importing a module script failed.')).toBe(true);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('shouldAutoReloadChunkFailure', () => {
  it('never reloads when reloadOnFail is false', () => {
    expect(shouldAutoReloadChunkFailure(false, false, 'https://app.example.com')).toBe(false);
    expect(shouldAutoReloadChunkFailure(false, false, undefined)).toBe(false);
  });

  it('never reloads inside the Tauri desktop', () => {
    expect(shouldAutoReloadChunkFailure(true, true, 'https://anything')).toBe(false);
    expect(shouldAutoReloadChunkFailure(true, true, undefined)).toBe(false);
  });

  it('never reloads on the static desktop host :3070 (localhost or 127.0.0.1)', () => {
    expect(shouldAutoReloadChunkFailure(true, false, 'http://localhost:3070')).toBe(false);
    expect(shouldAutoReloadChunkFailure(true, false, 'http://127.0.0.1:3070')).toBe(false);
  });

  it('never reloads on the vite preview host :4173 (localhost or 127.0.0.1)', () => {
    expect(shouldAutoReloadChunkFailure(true, false, 'http://localhost:4173')).toBe(false);
    expect(shouldAutoReloadChunkFailure(true, false, 'http://127.0.0.1:4173')).toBe(false);
  });

  it('reloads in a normal browser dev session (reloadOnFail, not tauri, other origin)', () => {
    expect(shouldAutoReloadChunkFailure(true, false, 'http://localhost:3055')).toBe(true);
    expect(shouldAutoReloadChunkFailure(true, false, 'https://app.example.com')).toBe(true);
  });

  it('reloads when origin is unknown but the other conditions allow it', () => {
    expect(shouldAutoReloadChunkFailure(true, false, undefined)).toBe(true);
  });

  it('a desktop-host origin still wins even if it is not the Tauri webview', () => {
    // e.g. a plain browser pointed at the static desktop host — still must not reload.
    expect(shouldAutoReloadChunkFailure(true, false, 'http://localhost:3070')).toBe(false);
  });
});
