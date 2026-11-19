import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createHash, webcrypto } from "node:crypto";
import { TextEncoder as NodeTextEncoder } from "node:util";

jest.mock("./apiBase", () => ({ apiBase: "" }));
jest.mock("../authToken", () => ({ setAccessToken: jest.fn() }));

import { LocaleProvider } from "../i18n/LocaleContext";
import { LoginCard } from "./LoginCard";

describe("security check at sign-in (NFR-020)", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
    Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });
  });

  it("solves the self-hosted challenge itself and signs in without asking the user", async () => {
    const salt = "abc123?expires=9999999999999";
    const challenge = createHash("sha256").update(`${salt}37`).digest("hex");
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 403, json: async () => ({ captchaRequired: true, provider: "self", reason: "failed-attempts", challenge: { algorithm: "SHA-256", salt, challenge, maxnumber: 100, signature: "sig" } }) };
      }
      return { ok: true, status: 200, json: async () => ({ session: { sessionId: "s" }, accessToken: "token", redirectTo: "workspace" }) };
    });
    const onAuthenticated = jest.fn();
    render(
      <LocaleProvider>
        <LoginCard onAuthenticated={onAuthenticated} />
      </LocaleProvider>
    );
    fireEvent.change(document.getElementById("username")!, { target: { value: "layla@irisstar.tech" } });
    fireEvent.change(document.getElementById("password")!, { target: { value: "pw" } });
    fireEvent.submit(document.getElementById("password")!.closest("form")!);

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    expect(bodies[0].captchaToken).toBeUndefined();
    const answer = JSON.parse(atob(bodies[1].captchaToken as string));
    expect(answer).toMatchObject({ salt, challenge, number: 37, signature: "sig" });
  });

  it("shows a message and a place for the widget when a third-party check is required", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ captchaRequired: true, provider: "turnstile", siteKey: "key", reason: "outside-approved-network" })
    }));
    render(
      <LocaleProvider>
        <LoginCard onAuthenticated={jest.fn()} />
      </LocaleProvider>
    );
    fireEvent.change(document.getElementById("username")!, { target: { value: "layla@irisstar.tech" } });
    fireEvent.change(document.getElementById("password")!, { target: { value: "pw" } });
    fireEvent.submit(document.getElementById("password")!.closest("form")!);
    expect(await screen.findByText(/Complete the security check below/)).toBeTruthy();
    expect(screen.getByLabelText("Security check")).toBeTruthy();
  });
});
