/**
 * Vitest stand-in for `expo-device` (the real module boots `expo`'s core, which
 * needs the bundler's machinery that node does not have).
 */
export const isDevice = true;
export const brand = 'google';
export const manufacturer = 'Google';
export const model = 'Pixel 8';
export const name = 'Pixel 8';
export const designName = 'Pixel 8';
export const productName = 'Pixel 8';
export const deviceType = 3;
export const osName = 'Android';
export const osVersion = '16';
export const platformApiLevel = 36;
export const totalMemory = 8_000_000_000;

export async function getMaxMemoryAsync(): Promise<number | null> {
  return totalMemory;
}

export default {
  isDevice,
  brand,
  manufacturer,
  model,
  name,
  designName,
  productName,
  deviceType,
  osName,
  osVersion,
  platformApiLevel,
  totalMemory,
  getMaxMemoryAsync,
};
