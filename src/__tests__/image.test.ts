import { describe, expect, it } from 'vitest';
import * as picker from '../__mocks__/expo-image-picker';

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  acceptsImages,
  attachmentFromAsset,
  base64ByteLength,
  dataUrl,
  encodeBase64,
  imageParts,
  mediaTypeFor,
  pickImages,
} from '../core/image';

describe('base64 payloads', () => {
  it('counts the bytes a base64 string decodes to', () => {
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength('aGVsbG8=')).toBe(5);
    expect(base64ByteLength('aGVsbG8gd29ybGQ=')).toBe(11);
    expect(base64ByteLength('YQ==')).toBe(1);
    // Newlines the native encoder can emit are not bytes.
    expect(base64ByteLength('aGVs\nbG8=')).toBe(5);
  });

  it('encodes bytes with the right padding', () => {
    expect(encodeBase64(new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]))).toBe('aGVsbG8=');
    expect(encodeBase64(new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x21]))).toBe('aGVsbG8h');
    expect(encodeBase64(new Uint8Array([0x68]))).toBe('aA==');
  });

  it('builds a data URL the dialect adapters accept', () => {
    expect(dataUrl('image/jpeg', 'aGVsbG8=')).toBe('data:image/jpeg;base64,aGVsbG8=');
  });

  it('labels what the bytes actually are', () => {
    // iOS re-encodes base64 output as JPEG whatever the picked file was.
    expect(mediaTypeFor({ mimeType: 'image/png' })).toBe('image/jpeg');
    expect(mediaTypeFor({ mimeType: null })).toBe('image/jpeg');
    expect(mediaTypeFor({ mimeType: 'application/pdf' })).toBe('image/jpeg');
  });
});

describe('turning a picked asset into a prompt part', () => {
  const jpeg = {
    uri: 'file:///sdcard/DCIM/photo.jpg',
    base64: 'aGVsbG8=',
    mimeType: 'image/jpeg',
    fileName: 'photo.jpg',
    fileSize: 5,
    type: 'image',
  };

  it('produces a file part with the data URL', () => {
    const attachment = attachmentFromAsset(jpeg);

    expect(attachment).toEqual({
      mediaType: 'image/jpeg',
      url: 'data:image/jpeg;base64,aGVsbG8=',
      name: 'photo.jpg',
      bytes: 5,
    });
    expect(imageParts([attachment as never])).toEqual([
      { type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,aGVsbG8=' },
    ]);
  });

  it('names a video instead of sending it', () => {
    const result = attachmentFromAsset({ ...jpeg, type: 'video' });

    expect(result).toEqual({ error: 'Only images can be sent — that file is a video.' });
  });

  it('names an oversized image rather than blowing the context window', () => {
    const result = attachmentFromAsset({ ...jpeg, fileSize: MAX_IMAGE_BYTES + 1 });

    expect(result).toEqual({
      error: `That image is 3.0 MB — the limit is ${(MAX_IMAGE_BYTES / 1_000_000).toFixed(1)} MB.`,
    });
  });

  it('names a pick that returned no data', () => {
    expect(attachmentFromAsset({ ...jpeg, base64: null })).toEqual({
      error: 'The picker returned no image data for that file.',
    });
    expect(attachmentFromAsset({ ...jpeg, base64: '' })).toEqual({
      error: 'The picker returned no image data for that file.',
    });
  });

  it('only offers images to models that declare vision', () => {
    expect(acceptsImages({ capabilities: { vision: true } })).toBe(true);
    expect(acceptsImages({ capabilities: { vision: false } })).toBe(false);
    expect(acceptsImages({ capabilities: undefined })).toBe(false);
    expect(MAX_IMAGES_PER_MESSAGE).toBe(4);
  });
});

describe('the picker', () => {
  const asset = {
    uri: 'file:///sdcard/DCIM/photo.jpg',
    base64: 'aGVsbG8=',
    mimeType: 'image/jpeg',
    fileName: 'photo.jpg',
    fileSize: 5,
    type: 'image',
  };

  it('stops when the permission is refused, and says whether it can be asked again', async () => {
    picker.setNextPermission({ granted: false, canAskAgain: true });

    expect(await pickImages()).toEqual({
      attachments: [],
      error: 'Photo library permission was not granted.',
    });

    picker.setNextPermission({ granted: false, canAskAgain: false });

    expect(await pickImages()).toEqual({
      attachments: [],
      error: 'Photo library permission is blocked — enable it in the system settings.',
    });

    picker.setNextPermission({ granted: true, canAskAgain: true });
  });

  it('treats cancellation as nothing, not a failure', async () => {
    picker.setNextResult({ canceled: true, assets: [] });

    expect(await pickImages()).toEqual({ attachments: [] });
  });

  it('converts every picked image', async () => {
    picker.setNextResult({
      canceled: false,
      assets: [asset, { ...asset, uri: 'file:///sdcard/DCIM/second.jpg', fileName: 'second.jpg' }],
    });

    const result = await pickImages();

    expect(result.attachments.map((a) => a.name)).toEqual(['photo.jpg', 'second.jpg']);
    expect(result.error).toBeUndefined();
  });

  it('keeps the usable images when one is rejected', async () => {
    picker.setNextResult({
      canceled: false,
      assets: [asset, { ...asset, fileName: 'clip.mp4', type: 'video' }],
    });

    const result = await pickImages();

    expect(result.attachments).toHaveLength(1);
    expect(result.error).toBe('Only images can be sent — that file is a video.');
  });

  it('refuses to add past the limit instead of truncating silently', async () => {
    expect(await pickImages({ remaining: 0 })).toEqual({
      attachments: [],
      error: `At most ${MAX_IMAGES_PER_MESSAGE} images can be sent in one message.`,
    });
  });

  it('names a picker that failed rather than reporting no selection', async () => {
    picker.setPendingResult({ code: 'E_PICKER', message: 'The camera app refused to open.' });

    expect(await pickImages()).toEqual({
      attachments: [],
      error: 'The picker failed: The camera app refused to open.',
    });
  });

  it('recovers a pick Android completed before killing the activity', async () => {
    picker.setPendingResult({ canceled: false, assets: [asset] });

    const result = await pickImages();

    expect(result.attachments.map((a) => a.name)).toEqual(['photo.jpg']);
    expect(result.error).toBeUndefined();
    // The recovered pick is consumed once, so it cannot be sent twice.
    picker.setNextResult({ canceled: true, assets: [] });
    expect(await pickImages()).toEqual({ attachments: [] });
  });
});
