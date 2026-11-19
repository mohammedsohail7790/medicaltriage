import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoginModule, minifyHtml, obfuscateLoginCode } from "../frontend/vite.hardening.js";

describe("NFR-147 web client hardening", () => {
  describe("helpers", () => {
    it("recognises the sign-in modules and nothing else", () => {
      expect(isLoginModule("/repo/frontend/src/auth/LoginCard.tsx")).toBe(true);
      expect(isLoginModule("/repo/frontend/src/auth/loginTransport.ts")).toBe(true);
      expect(isLoginModule("/repo/frontend/src/auth/LoginCard.tsx?v=1")).toBe(true);
      expect(isLoginModule("/repo/frontend/src/auth/loginTransport.test.ts")).toBe(false);
      expect(isLoginModule("/repo/frontend/src/App.tsx")).toBe(false);
      expect(isLoginModule("C:\\repo\\frontend\\src\\auth\\session.ts")).toBe(true);
    });

    it("minifies HTML without touching attributes or text", () => {
      const html = `<!doctype html>\n<html>\n  <!-- a comment -->\n  <head>\n    <title>IST Health</title>\n    <link rel="stylesheet" href="/a.css" />\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n`;
      expect(minifyHtml(html)).toBe('<!doctype html><html><head><title>IST Health</title><link rel="stylesheet" href="/a.css"/></head><body><div id="root"></div></body></html>');
    });

    it("obfuscates code without changing what it does", () => {
      const source = `(function () { const secretPath = "/api/v1/auth/login-config"; function double(n) { return n * 2; } globalThis.__out = [secretPath, double(21)]; })();`;
      const obfuscated = obfuscateLoginCode(source);
      expect(obfuscated).not.toContain("/api/v1/auth/login-config");
      expect(obfuscated).not.toContain("function double");
      // eslint-disable-next-line no-new-func
      new Function(obfuscated)();
      expect((globalThis as unknown as { __out: unknown[] }).__out).toEqual(["/api/v1/auth/login-config", 42]);
    });
  });

  describe("production build", () => {
    let outDir: string;
    let files: Record<string, string>;
    beforeAll(() => {
      outDir = mkdtempSync(join(tmpdir(), "web-build-"));
      execFileSync("npx", ["vite", "build", "--config", "frontend/vite.config.ts", "--outDir", outDir, "--emptyOutDir"], { stdio: "pipe", timeout: 180_000, env: { ...process.env, NODE_ENV: "production" } });
      files = Object.fromEntries(
        [...readdirSync(outDir), ...readdirSync(join(outDir, "assets")).map((f) => `assets/${f}`)]
          .filter((f) => /\.(js|html|map)$/.test(f))
          .map((f) => [f, readFileSync(join(outDir, f), "utf8")])
      );
    }, 240_000);
    afterAll(() => rmSync(outDir, { recursive: true, force: true }));

    it("ships one application script, so the server can serve it as a deferred script", () => {
      expect(Object.keys(files).filter((f) => f.endsWith(".js") && f.startsWith("assets/index-"))).toHaveLength(1);
      expect(Object.keys(files).filter((f) => f.endsWith(".js") && f.includes("login-"))).toHaveLength(0);
    });

    it("publishes no source maps", () => {
      expect(Object.keys(files).filter((f) => f.endsWith(".map"))).toEqual([]);
      for (const [name, code] of Object.entries(files)) if (name.endsWith(".js")) expect(code).not.toContain("sourceMappingURL");
    });

    it("minifies the JavaScript into very long lines (and builds React in production mode)", () => {
      const [, code] = Object.entries(files).find(([name]) => /assets\/index-.*\.js$/.test(name))!;
      const lines = code.split("\n");
      // Unminified output of a bundle this size is tens of thousands of short, indented lines.
      expect(lines.length).toBeLessThan(2000);
      expect(lines.filter((line) => /^\s{4,}\S/.test(line)).length).toBeLessThan(100);
      expect(code.length / lines.length).toBeGreaterThan(500);
    });

    it("obfuscates the sign-in code: its readable names and messages are gone", () => {
      const [, code] = Object.entries(files).find(([name]) => /assets\/index-.*\.js$/.test(name))!;
      for (const readable of ["submitPasswordChange", "loadPasswordRules", "buildLoginRequest", "solveSelfChallenge", "renderCaptchaWidget", "Choose a new password", "The security check could not be completed.", "/api/v1/auth/login-config"]) {
        expect(code).not.toContain(readable);
      }
      // The string-array decoder the obfuscator adds survives minification as a run of parseInt(decoder(n)) terms.
      expect(code).toMatch(/parseInt\([\w$]+\(\d+\)\)\/\d+/);
    });

    it("leaves the rest of the application readable enough to support (names of ordinary code are not obfuscated)", () => {
      const [, code] = Object.entries(files).find(([name]) => /assets\/index-.*\.js$/.test(name))!;
      expect(code).toContain("Authentication service unavailable.");
      expect(code).not.toContain("react-stack-top-frame"); // the development build of React
    });

    it("minifies the HTML page", () => {
      expect(files["index.html"]).not.toMatch(/>\s+</);
      expect(files["index.html"]).not.toContain("<!--");
      expect(files["index.html"]).toContain('<div id="root"></div>');
    });
  });
});
