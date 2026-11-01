/**
 * Classifies a request that never produced an HTTP status.
 *
 * "Failed to fetch" is what a dropped connection and a browser-blocked request
 * both look like from JavaScript, so the endpoint is compared against the page's
 * own origin to tell them apart: a web page cannot POST an `Authorization`
 * header to a vendor that sends no `Access-Control-Allow-Origin`, and the key
 * never leaves the browser. Native builds have no CORS, so the same message
 * there really is a network failure.
 */
import { Platform } from 'react-native';

import { elideText } from './context';

/** Failures reported without a status: DNS, TLS, dropped sockets, CORS. */
const TRANSPORT_FAILURE =
  /failed to fetch|network (request )?failed|connection (refused|reset|closed|timed out)|unable to resolve host|ssl|tls|handshake/i;

export function isTransportFailure(message: string): boolean {
  return TRANSPORT_FAILURE.test(message);
}

/** `scheme://host:port` of a URL; empty when it is not a parseable URL. */
export function urlOrigin(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);

    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

/** Origin of the running page; empty outside a browser, where CORS does not apply. */
export function pageOrigin(): string {
  if (Platform.OS !== 'web') {
    return '';
  }

  const location = (globalThis as { location?: { origin?: string } }).location;

  return typeof location?.origin === 'string' ? location.origin : '';
}

/**
 * One line for a status-less failure. `origin` is injected so tests can decide
 * the platform instead of depending on the runtime's own `location`.
 */
export function describeTransportFailure(
  raw: string,
  baseUrl: string,
  origin: string = pageOrigin(),
): string {
  const target = urlOrigin(baseUrl);

  if (origin.length > 0 && target.length > 0 && target !== origin) {
    return elideText(
      `blocked by the browser · ${target} sends no Access-Control-Allow-Origin to ${origin}` +
        ' (its OPTIONS preflight is not answered)' +
        ' — the key never left the page. A LAN server can send CORS headers; the phone build has no CORS',
      260,
    );
  }

  // The target is named when it is known: a tool fetch can fail on any URL, and
  // "the server" would not say which one.
  return elideText(
    `network error · the request never reached ${target.length > 0 ? target : 'the server'} (${raw})`,
    220,
  );
}
