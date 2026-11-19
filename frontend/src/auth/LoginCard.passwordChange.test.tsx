import { fireEvent, render, screen, waitFor } from "@testing-library/react";
jest.mock("./apiBase", () => ({ apiBase: "" }));

import { LocaleProvider } from "../i18n/LocaleContext";
import { LoginCard } from "./LoginCard";

type Reply = { status: number; body: unknown };
function mockFetch(routes: Record<string, Reply>) {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string) => {
    const key = Object.keys(routes).find((route) => String(url).endsWith(route));
    const reply = key ? routes[key] : { status: 404, body: {} };
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
  });
}

function signIn() {
  render(
    <LocaleProvider>
      <LoginCard onAuthenticated={jest.fn()} />
    </LocaleProvider>
  );
  fireEvent.change(document.getElementById("username")!, { target: { value: "new.user@irisstar.tech" } });
  fireEvent.change(document.getElementById("password")!, { target: { value: "temp-password" } });
  fireEvent.submit(document.getElementById("password")!.closest("form")!);
}

describe("password change at sign-in (NFR-016)", () => {
  const policy = { minLength: 12, requireUppercase: true, requireLowercase: true, requireDigit: true, requireSymbol: true, historyCount: 5, maxAgeDays: 90 };

  it("asks for a new password when the server says the temporary password must be changed", async () => {
    mockFetch({
      "/auth/login": { status: 403, body: { error: "Authentication failed", message: "temporary", passwordChangeRequired: "temporary" } },
      "/auth/password/policy": { status: 200, body: policy }
    });
    signIn();
    expect(await screen.findByText("Choose a new password")).toBeTruthy();
    expect(screen.getByText(/You are using a temporary password/)).toBeTruthy();
    expect(await screen.findByText(/At least 12 characters/)).toBeTruthy();
  });

  it("says so when the password has expired", async () => {
    mockFetch({
      "/auth/login": { status: 403, body: { passwordChangeRequired: "expired" } },
      "/auth/password/policy": { status: 200, body: policy }
    });
    signIn();
    expect(await screen.findByText(/Your password has expired/)).toBeTruthy();
  });

  it("checks the two entries match, lists every rule the server reports, and returns to sign-in after success", async () => {
    mockFetch({
      "/auth/login": { status: 403, body: { passwordChangeRequired: "temporary" } },
      "/auth/password/policy": { status: 200, body: policy },
      "/auth/password/change": { status: 422, body: { violations: ["Include a digit.", "Include a symbol."] } }
    });
    signIn();
    await screen.findByText("Choose a new password");
    fireEvent.change(document.getElementById("new-password")!, { target: { value: "Abcdefghijkl" } });
    fireEvent.change(document.getElementById("confirm-password")!, { target: { value: "different" } });
    fireEvent.submit(document.getElementById("new-password")!.closest("form")!);
    expect(await screen.findByText("The two new passwords do not match.")).toBeTruthy();

    fireEvent.change(document.getElementById("confirm-password")!, { target: { value: "Abcdefghijkl" } });
    fireEvent.submit(document.getElementById("new-password")!.closest("form")!);
    expect(await screen.findByText("Include a digit.")).toBeTruthy();
    expect(screen.getByText("Include a symbol.")).toBeTruthy();

    mockFetch({ "/auth/password/change": { status: 200, body: { changed: true } } });
    fireEvent.change(document.getElementById("new-password")!, { target: { value: "Abcdefghijk1!" } });
    fireEvent.change(document.getElementById("confirm-password")!, { target: { value: "Abcdefghijk1!" } });
    fireEvent.submit(document.getElementById("new-password")!.closest("form")!);
    await waitFor(() => expect(screen.getByText(/Your password was changed/)).toBeTruthy());
    expect(document.getElementById("username")).toBeTruthy();
  });
});
