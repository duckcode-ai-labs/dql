/** The file name the fonts' licence gets beside the font files in a build. */
export declare const FONT_LICENCE_FILE: string;
/** The licence text of the fonts DQL serves itself (fonts/OFL.txt). */
export declare function fontLicenceText(): string;
/** A Vite plugin that writes the fonts' licence beside the font files a build copies. */
export declare function fontLicence(): {
  name: string;
  apply: 'build';
  generateBundle(
    this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): string },
    options: unknown,
    bundle: Record<string, { type: string; fileName: string }>,
  ): void;
};
