import JavaScriptObfuscator from "javascript-obfuscator";
import type { Plugin } from "vite";

/**
 * Production-build hardening of the web client (NFR-147).
 *
 *  - Everything is minified (Vite's default, kept explicit in vite.config.ts).
 *  - The sign-in page's code (src/auth) is obfuscated so its structure is not readable. Only
 *    those modules are obfuscated: obfuscating the whole application would slow it down and make
 *    support harder for no gain. They are obfuscated in place and stay in the single application
 *    bundle, because the server serves that bundle as one deferred script (src/app.ts), which
 *    cannot load a bundle that imports other chunks.
 *  - The HTML is minified (comments and whitespace between tags removed).
 *
 * The obfuscation settings are deliberately the safe ones: no control-flow flattening, dead code
 * or self-defending code, which can break React or conflict with the page's Content-Security-Policy.
 */

/** The modules that make up the sign-in page. */
export function isLoginModule(id: string): boolean {
  return /[\\/]frontend[\\/]src[\\/]auth[\\/][^?]*\.[tj]sx?(\?|$)/.test(id) && !/\.test\.[tj]sx?(\?|$)/.test(id);
}

export function minifyHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+\/>/g, "/>")
    .trim();
}

export function obfuscateLoginCode(code: string): string {
  return JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    simplify: true,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    stringArray: true,
    stringArrayThreshold: 1,
    stringArrayEncoding: ["base64"],
    stringArrayRotate: true,
    stringArrayShuffle: true,
    splitStrings: false,
    transformObjectKeys: false,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    selfDefending: false,
    debugProtection: false,
    disableConsoleOutput: false,
    numbersToExpressions: false,
    unicodeEscapeSequence: false,
    target: "browser"
  }).getObfuscatedCode();
}

export function webHardening(): Plugin[] {
  return [
    {
      name: "login-code-obfuscation",
      apply: "build",
      // After TypeScript and JSX have been compiled to plain JavaScript.
      enforce: "post",
      transform(code, id) {
        if (!isLoginModule(id)) return null;
        return { code: obfuscateLoginCode(code), map: null };
      }
    },
    {
      name: "minify-html",
      apply: "build",
      transformIndexHtml: { order: "post", handler: minifyHtml }
    }
  ];
}
