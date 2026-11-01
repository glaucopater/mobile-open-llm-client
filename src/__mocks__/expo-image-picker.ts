/**
 * Vitest stand-in for `expo-image-picker`. The real module talks to the native
 * picker through expo-modules-core, which node does not have; tests only need
 * the entry points `core/image.ts` calls.
 */
export interface PermissionResponse {
  granted: boolean;
  canAskAgain: boolean;
}

export interface ImagePickerAsset {
  uri: string;
  base64?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number;
  type?: string | null;
}

export interface ImagePickerResult {
  canceled: boolean;
  assets: ImagePickerAsset[];
}

/** Everything the tests pick, in order; the native picker is never opened. */
let nextResult: ImagePickerResult = { canceled: true, assets: [] };
let nextPermission: PermissionResponse = { granted: true, canAskAgain: true };
let pendingResult: ImagePickerResult | { code: string; message: string } | null = null;

export function setNextResult(result: ImagePickerResult): void {
  nextResult = result;
}

export function setNextPermission(permission: PermissionResponse): void {
  nextPermission = permission;
}

/** Stands in for a pick Android completed before it killed the activity. */
export function setPendingResult(result: ImagePickerResult | { code: string; message: string } | null): void {
  pendingResult = result;
}

export async function getPendingResultAsync(): Promise<
  ImagePickerResult | { code: string; message: string } | null
> {
  const recovered = pendingResult;
  pendingResult = null;

  return recovered;
}

export async function requestMediaLibraryPermissionsAsync(): Promise<PermissionResponse> {
  return nextPermission;
}

export async function launchImageLibraryAsync(): Promise<ImagePickerResult> {
  return nextResult;
}
