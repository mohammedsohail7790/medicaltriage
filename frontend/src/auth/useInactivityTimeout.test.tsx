import { act, render } from "@testing-library/react";
import { useInactivityTimeout } from "./useInactivityTimeout";

function Probe({ onTimeout, idle }: { onTimeout: () => void; idle: number }) {
  useInactivityTimeout({ enabled: true, apiBase: "", onTimeout, idleSecondsOverride: idle });
  return null;
}

describe("useInactivityTimeout (NFR-145)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({ status: 204 });
  });
  afterEach(() => jest.useRealTimers());

  it("signs out after the idle period with no user input", () => {
    const onTimeout = jest.fn();
    render(<Probe onTimeout={onTimeout} idle={20} />);
    act(() => void jest.advanceTimersByTime(19_000));
    expect(onTimeout).not.toHaveBeenCalled();
    act(() => void jest.advanceTimersByTime(3_000));
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not sign out while the user keeps working, and pings the server", () => {
    const onTimeout = jest.fn();
    render(<Probe onTimeout={onTimeout} idle={20} />);
    for (let i = 0; i < 6; i += 1) {
      act(() => {
        window.dispatchEvent(new Event("keydown"));
        jest.advanceTimersByTime(8_000);
      });
    }
    expect(onTimeout).not.toHaveBeenCalled();
    expect((global as unknown as { fetch: jest.Mock }).fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/auth/activity"), expect.objectContaining({ method: "POST" }));
  });

  it("signs out when the server says the session has already ended", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({ status: 401 });
    const onTimeout = jest.fn();
    render(<Probe onTimeout={onTimeout} idle={20} />);
    await act(async () => {
      window.dispatchEvent(new Event("keydown"));
      jest.advanceTimersByTime(8_000);
    });
    expect(onTimeout).toHaveBeenCalled();
  });
});
