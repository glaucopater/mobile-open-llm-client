import { afterEach, describe, expect, it, jest } from '@jest/globals';

import '../polyfills';

const mutableGlobals = globalThis as unknown as Record<string, unknown>;

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

    jest.isolateModules(() => {
      jest.requireActual('../polyfills');
    });

    expect(globalThis.structuredClone).toBe(nativeClone);
  });

  it('installs fallbacks on a runtime that lacks the APIs', () => {
    const snapshot = {
      structuredClone: mutableGlobals.structuredClone,
      TextEncoderStream: mutableGlobals.TextEncoderStream,
      TextDecoderStream: mutableGlobals.TextDecoderStream,
    };

    delete mutableGlobals.structuredClone;
    delete mutableGlobals.TextEncoderStream;
    delete mutableGlobals.TextDecoderStream;

    jest.isolateModules(() => {
      jest.requireActual('../polyfills');
    });

    expect(typeof mutableGlobals.structuredClone).toBe('function');
    expect(typeof mutableGlobals.TextEncoderStream).toBe('function');
    expect(typeof mutableGlobals.TextDecoderStream).toBe('function');
    expect(globalThis.structuredClone({ a: [1] })).toEqual({ a: [1] });

    for (const [name, value] of Object.entries(snapshot)) {
      mutableGlobals[name] = value;
    }
  });
});

afterEach(() => {
  jest.resetModules();
});
