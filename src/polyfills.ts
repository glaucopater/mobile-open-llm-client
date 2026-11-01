/**
 * Runtime capability guards for Hermes.
 *
 * Expo SDK 58 installs the Winter globals it needs (`fetch` from `expo/fetch`,
 * `ReadableStream`, `TransformStream`, `TextEncoderStream`, `TextDecoderStream`,
 * `structuredClone`). These guards only fill gaps for runtimes that ship without
 * them, and never replace a native implementation.
 *
 * The AI SDK needs all of these when parsing streamed provider responses.
 */
import { deserialize, serialize } from '@ungap/structured-clone';

const mutableGlobals = globalThis as unknown as Record<string, unknown>;

function install(name: string, factory: () => unknown): void {
  if (typeof mutableGlobals[name] === 'function') {
    return;
  }

  mutableGlobals[name] = factory();
}

/**
 * Fills the gaps a runtime may have. Exported so the suites can re-run it on a
 * runtime they have stripped, instead of relying on the runner's module registry.
 */
export function installRuntimePolyfills(): void {
  install('structuredClone', () => {
    return <T>(value: T): T => deserialize(serialize(value)) as T;
  });

  // Hermes lacks the async iterator symbol, which ReadableStream.prototype.values
  // and the AI SDK's stream consumers rely on.
  if (typeof Symbol.asyncIterator !== 'symbol') {
    (Symbol as unknown as { asyncIterator: symbol }).asyncIterator = Symbol.for(
      'Symbol.asyncIterator',
    );
  }

  install('TextEncoderStream', () => {
    const encoder = new TextEncoder();

    return class PolyfilledTextEncoderStream {
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
    };
  });

  install('TextDecoderStream', () => {
    const decoder = new TextDecoder();

    return class PolyfilledTextDecoderStream {
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
    };
  });
}

installRuntimePolyfills();
