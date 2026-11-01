/**
 * Vitest stand-in for `expo-file-system`'s new `File`/`Paths` API.
 *
 * The real class needs the native module; the suites only need the sandbox the
 * tools use, so contents are kept in a map keyed by the relative path.
 */
const contents = new Map<string, string>();

export const Paths = {
  document: 'file:///documents',
  cache: 'file:///cache',
  bundle: 'file:///bundle',
};

export class File {
  uri: string;

  constructor(directory: string, filename: string) {
    this.uri = `${directory}/${filename}`;
  }

  get exists(): boolean {
    return contents.has(this.uri);
  }

  async text(): Promise<string> {
    return contents.get(this.uri) ?? '';
  }

  async write(value: string): Promise<void> {
    contents.set(this.uri, value);
  }

  async delete(): Promise<void> {
    contents.delete(this.uri);
  }
}

export default { File, Paths };
