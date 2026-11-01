/**
 * Image attachments for vision models.
 *
 * A picked photo is turned into a base64 data URL and sent as an AI SDK `file`
 * part, which each dialect adapter converts to its own image shape
 * (`image_url`, Anthropic `image`, Gemini `inlineData`). Nothing is uploaded
 * anywhere else: the bytes go in the prompt to the endpoint the provider is set
 * to.
 *
 * `expo-image-picker` returns base64 directly (`base64: true`) so no file read
 * is needed. Both native pickers hand back JPEG (see `mediaTypeFor`), and the
 * web picker reports the browser's own file type.
 */
import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import type { FileUIPart } from 'ai';

/** Most images in one message: providers charge per image and cap the count. */
export const MAX_IMAGES_PER_MESSAGE = 4;

/**
 * Cap on the encoded payload. A phone photo is several megabytes, and the base64
 * form is ~33% larger than the file, so an uncapped pick can blow the context
 * window before the guard can trim anything.
 */
export const MAX_IMAGE_BYTES = 3_000_000;

/** JPEG quality passed to the picker: smaller payload, still readable text. */
export const PICKER_JPEG_QUALITY = 0.8;

export interface ImageAttachment {
  mediaType: string;
  /** Data URL handed to the model as a `file` part. */
  url: string;
  name: string;
  /** Decoded byte count, not the base64 length. */
  bytes: number;
}

/** A `file` part for the AI SDK's user message — the shape `sendMessage({ files })` takes. */
export type ImagePart = FileUIPart;

/** Bytes a base64 string decodes to, accounting for `=` padding. */
export function base64ByteLength(base64: string): number {
  const body = base64.replace(/\s+/g, '');

  if (body.length === 0) {
    return 0;
  }

  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;

  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

export function dataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

/**
 * Media type the bytes actually are. The native picker hands back base64 of a
 * JPEG it re-encoded (iOS always, Android whenever `quality` is set, which we
 * always set), so trusting the picked file's own type would mislabel the data.
 * The web picker does not transcode, so its declared type is used there.
 */
export function mediaTypeFor(asset: { mimeType?: string | null }): string {
  if (Platform.OS === 'web') {
    const declared = asset.mimeType ?? '';

    return declared.startsWith('image/') ? declared : 'image/jpeg';
  }

  return 'image/jpeg';
}

/** Base64 for a byte array; the web picker hands us a blob instead of base64. */
export function encodeBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';

  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = bytes.subarray(i, Math.min(i + 3, bytes.length));
    const bits = (chunk[0] << 16) | ((chunk[1] ?? 0) << 8) | (chunk[2] ?? 0);

    out += alphabet[(bits >> 18) & 63] + alphabet[(bits >> 12) & 63];
    out += chunk.length > 1 ? alphabet[(bits >> 6) & 63] : '=';
    out += chunk.length > 2 ? alphabet[bits & 63] : '=';
  }

  return out;
}

/** Reads a blob/data URL as base64; only needed on web, where the picker has no encoder. */
async function base64FromUri(uri: string): Promise<string | null> {
  if (uri.startsWith('data:')) {
    return uri.slice(uri.indexOf(',') + 1);
  }

  try {
    const response = await fetch(uri);
    const buffer = await response.arrayBuffer();

    return encodeBase64(new Uint8Array(buffer));
  } catch {
    return null;
  }
}

/**
 * Converts one picked asset into an attachment, or explains why it cannot be
 * used — a video or an oversized file is named rather than silently dropped.
 */
export function attachmentFromAsset(asset: {
  uri: string;
  base64?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number;
  type?: string | null;
}): ImageAttachment | { error: string } {
  if (asset.type !== null && asset.type !== undefined && asset.type !== 'image') {
    return { error: `Only images can be sent — that file is a ${asset.type}.` };
  }

  const mediaType = mediaTypeFor(asset);
  const base64 = asset.base64 ?? null;

  if (base64 === null || base64.length === 0) {
    return { error: 'The picker returned no image data for that file.' };
  }

  const bytes = asset.fileSize ?? base64ByteLength(base64);

  if (bytes > MAX_IMAGE_BYTES) {
    return {
      error: `That image is ${(bytes / 1_000_000).toFixed(1)} MB — the limit is ${(MAX_IMAGE_BYTES / 1_000_000).toFixed(1)} MB.`,
    };
  }

  return {
    mediaType,
    url: dataUrl(mediaType, base64),
    name: asset.fileName ?? 'image',
    bytes: base64ByteLength(base64),
  };
}

export function imageParts(attachments: ImageAttachment[]): ImagePart[] {
  return attachments.map((attachment) => ({
    type: 'file',
    mediaType: attachment.mediaType,
    url: attachment.url,
  }));
}

/**
 * Opens the system picker. Permission is requested first (the library needs none
 * on Android/iOS to launch, but reading it does); cancellation is not an error.
 * The camera is not offered: one button keeps the composer honest about what a
 * message can carry, and the gallery covers both photos and saved images.
 */
export async function pickImages(
  options: { remaining?: number } = {},
): Promise<{ attachments: ImageAttachment[]; error?: string }> {
  const remaining = options.remaining ?? MAX_IMAGES_PER_MESSAGE;

  if (remaining <= 0) {
    return {
      attachments: [],
      error: `At most ${MAX_IMAGES_PER_MESSAGE} images can be sent in one message.`,
    };
  }

  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

  if (!permission.granted) {
    return {
      attachments: [],
      error: permission.canAskAgain
        ? 'Photo library permission was not granted.'
        : 'Photo library permission is blocked — enable it in the system settings.',
    };
  }

  // Android can kill the activity while the picker is open. The pick survives in
  // the native module, so it is read back before a new picker is opened.
  const recovered = await ImagePicker.getPendingResultAsync();

  const result =
    recovered ??
    (await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: remaining > 1,
      selectionLimit: remaining,
      quality: PICKER_JPEG_QUALITY,
      base64: true,
    }));

  // The picker can fail outright (`ImagePickerErrorResult`) instead of
  // cancelling; its message is the difference between "nothing picked" and
  // "the picker broke".
  if ('code' in result || 'message' in result) {
    const failure = result as { code?: string; message?: string };

    return {
      attachments: [],
      error: `The picker failed: ${failure.message ?? failure.code}`,
    };
  }

  if (result.canceled) {
    return { attachments: [] };
  }

  const assets = result.assets ?? [];
  const attachments: ImageAttachment[] = [];
  const errors: string[] = [];

  for (const asset of assets) {
    // The browser picker hands back a blob URL; encoding it here keeps the same
    // data-URL path the native picker uses.
    const filled =
      Platform.OS === 'web' && (asset.base64 === null || asset.base64 === undefined)
        ? { ...asset, base64: await base64FromUri(asset.uri) }
        : asset;

    const converted = attachmentFromAsset(filled);

    if ('error' in converted) {
      errors.push(converted.error);
      continue;
    }

    attachments.push(converted);
  }

  if (attachments.length === 0 && errors.length === 0) {
    return { attachments: [], error: 'No image was selected.' };
  }

  return {
    attachments,
    error: errors.length > 0 ? errors.join(' ') : undefined,
  };
}

/** Whether the model can take image parts at all. */
export function acceptsImages(model: { capabilities?: { vision?: boolean } }): boolean {
  return model.capabilities?.vision === true;
}
