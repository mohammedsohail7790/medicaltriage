import { productName } from "./brand";

describe("OI-39 configurable product name", () => {
  afterEach(() => {
    delete (globalThis as { __APP_BRAND__?: unknown }).__APP_BRAND__;
  });
  it("defaults to IST Health", () => expect(productName()).toBe("IST Health"));
  it("uses the deployment's name when one is set", () => {
    (globalThis as { __APP_BRAND__?: unknown }).__APP_BRAND__ = { productName: "Qatar Airways Tele-Triage" };
    expect(productName()).toBe("Qatar Airways Tele-Triage");
  });
  it("ignores a blank name", () => {
    (globalThis as { __APP_BRAND__?: unknown }).__APP_BRAND__ = { productName: "  " };
    expect(productName()).toBe("IST Health");
  });
});
