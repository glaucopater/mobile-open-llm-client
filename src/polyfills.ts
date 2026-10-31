/**
 * Runtime polyfills for Hermes.
 *
 * The AI SDK relies on web streams and `structuredClone` when parsing streamed
 * provider responses. Hermes ships neither, and RN's bundled `fetch` buffers the
 * whole response, so chat streaming uses `expo/fetch` explicitly instead.
 *
 * Every assignment is guarded: on runtimes that already provide the API (web,
 * future Hermes versions) the native implementation wins. The globals are typed
 * as `unknown` so this file never fights the DOM lib declarations that
 * TypeScript already ships for these names.
 */
import { deserialize, serialize } from '@ungap/structured-clone';
import {
  ReadableStream,
  TransformStream,
  WritableStream,
} from 'web-streams-polyfill';

type EncoderStream = {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<string>;
};

type DecoderStream = {
  readonly readable: ReadableStream<string>;
  readonly writable: WritableStream<Uint8Array>;
};

const mutableGlobals = globalThis as unknown as {
  structuredClone?: unknown;
  TextEncoderStream?: unknown;
  TextDecoderStream?: unknown;
};

function installStructuredClone(): void {
  if (typeof mutableGlobals.structuredClone === 'function') {
    return;
  }
  mutableGlobals.structuredClone = <T>(value: T): T => deserialize(serialize(value));
}

function installTextEncoderStream(): void {
  if (typeof mutableGlobals.TextEncoderStream === 'function') {
    return;
  }

  const encoder = new TextEncoder();

  class PolyfilledTextEncoderStream implements EncoderStream {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<string>;

    constructor() {
      const stream = new TransformStream<string, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(encoder.encode(chunk));
        },
      });
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  }

  mutableGlobals.TextEncoderStream = PolyfilledTextEncoderStream;
}

function installTextDecoderStream(): void {
  if (typeof mutableGlobals.TextDecoderStream === 'function') {
    return;
  }

  const decoder = new TextDecoder();

  class PolyfilledTextDecoderStream implements DecoderStream {
    readonly readable: ReadableStream<string>;
    readonly writable: WritableStream<Uint8Array>;

    constructor() {
      const stream = new TransformStream<Uint8Array, string>({
        transform(chunk, controller) {
          controller.enqueue(decoder.decode(chunk));
        },
      });
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  }

  mutableGlobals.TextDecoderStream = PolyfilledTextDecoderStream;
}

installStructuredClone();
installTextEncoderStream();
installTextDecoderStream();

export {};
