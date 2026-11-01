/**
 * Metro resolves image imports to a static asset handle (a number on native),
 * which the RN type package no longer declares, so the app bar's `import icon
 * from '../assets/icon.png'` needs this ambient declaration.
 */
declare module '*.png' {
  const source: number;
  export default source;
}
