import { describe, expect, it } from '@jest/globals';

import '../polyfills';

describe('runtime polyfills', () => {
  it('provides structuredClone', () => {
    expect(typeof globalThis.structuredClone).toBe('function');

    const source = { parts: [{ text: 'hi' }], tags: new Set(['a']) };
    const clone = globalThis.structuredClone(source);

    expect(clone).toEqual(source);
    expect(clone.parts).not.toBe(source.parts);
  });

  it('encodes text through TextEncoderStream', async () => {
    const stream = new globalThis.TextEncoderStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    // A TransformStream's readable has a high water mark of 0, so pull before
    // writing or the write promise never settles.
    const first = reader.read();
    await writer.write('hello');
    await writer.close();

    const { value } = await first;
    expect(Array.from(value ?? new Uint8Array())).toEqual([
      104, 101, 108, 108, 111,
    ]);
  });

  it('decodes bytes through TextDecoderStream', async () => {
    const stream = new globalThis.TextDecoderStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    const first = reader.read();
    await writer.write(new Uint8Array([104, 101, 108, 108, 111]));
    await writer.close();

    const { value } = await first;
    expect(value).toBe('hello');
  });
});
