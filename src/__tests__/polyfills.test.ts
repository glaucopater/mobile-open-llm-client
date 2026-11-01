import { afterEach, describe, expect, it } from 'vitest';

import { installRuntimePolyfills } from '../polyfills';

const mutableGlobals = globalThis as unknown as Record<string, unknown>;

/** Names the guards may have installed, so a stripped runtime can be restored. */
const GUARDED_NAMES = ['structuredClone', 'TextEncoderStream', 'TextDecoderStream'] as const;

describe('runtime capability guards', () => {
  it('provides structuredClone', () => {
    expect(typeof globalThis.structuredClone).toBe('function');

    const source = { parts: [{ text: 'hi' }], tags: new Set(['a']) };
    const clone = globalThis.structuredClone(source);

    expect(clone).toEqual(source);
    expect(clone.parts).not.toBe(source.parts);
  });

  it('exposes text encoder and decoder streams', async () => {
    expect(typeof globalThis.TextEncoderStream).toBe('function');
    expect(typeof globalThis.TextDecoderStream).toBe('function');

    const encoder = new globalThis.TextEncoderStream();
    const writer = encoder.writable.getWriter();
    const reader = encoder.readable.getReader();

    // A TransformStream's readable has a high water mark of 0, so pull before
    // writing or the write promise never settles.
    const encoded = reader.read();
    await writer.write('hello');
    await writer.close();

    const { value } = await encoded;
    expect(Array.from(value ?? new Uint8Array())).toEqual([104, 101, 108, 108, 111]);

    const decoder = new globalThis.TextDecoderStream();
    const decoderWriter = decoder.writable.getWriter();
    const decoderReader = decoder.readable.getReader();

    const decoded = decoderReader.read();
    await decoderWriter.write(new Uint8Array([104, 101, 108, 108, 111]));
    await decoderWriter.close();

    const { value: text } = await decoded;
    expect(text).toBe('hello');
  });

  it('keeps a native implementation instead of replacing it', () => {
    const nativeClone = globalThis.structuredClone;

    installRuntimePolyfills();

    expect(globalThis.structuredClone).toBe(nativeClone);
  });

  it('installs fallbacks on a runtime that lacks the APIs', () => {
    const snapshot: Record<string, unknown> = {};

    for (const name of GUARDED_NAMES) {
      snapshot[name] = mutableGlobals[name];
      delete mutableGlobals[name];
    }

    installRuntimePolyfills();

    for (const name of GUARDED_NAMES) {
      expect(typeof mutableGlobals[name]).toBe('function');
    }

    expect(globalThis.structuredClone({ a: [1] })).toEqual({ a: [1] });

    for (const [name, value] of Object.entries(snapshot)) {
      mutableGlobals[name] = value;
    }
  });
});

afterEach(() => {
  // The stripped-runtime test mutates real globals, so every test starts clean.
  for (const name of GUARDED_NAMES) {
    if (mutableGlobals[name] === undefined) {
      installRuntimePolyfills();
    }
  }
});
