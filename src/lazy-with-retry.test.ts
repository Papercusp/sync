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
import { shouldAutoReloadChunkFailure } from './lazy-with-retry';

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
