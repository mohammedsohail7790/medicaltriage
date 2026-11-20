import { fireEvent, render, screen } from "@testing-library/react";
import { isLowBandwidth, useDraft } from "./lowBandwidth";

function Box({ id }: { id: string }) {
  const [text, setText, clear] = useDraft(id, "start");
  return (
    <div>
      <input aria-label="text" value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={clear}>sent</button>
    </div>
  );
}

beforeEach(() => window.localStorage.clear());

describe("slow-connection support (NFR-122)", () => {
  it("recognises data-saver and slow connections only", () => {
    expect(isLowBandwidth({})).toBe(false);
    expect(isLowBandwidth({ connection: { effectiveType: "4g" } })).toBe(false);
    expect(isLowBandwidth({ connection: { effectiveType: "2g" } })).toBe(true);
    expect(isLowBandwidth({ connection: { effectiveType: "4g", saveData: true } })).toBe(true);
  });

  it("keeps what was typed across a reload, and drops it once sent", () => {
    const first = render(<Box id="case-1" />);
    fireEvent.change(screen.getByLabelText("text"), { target: { value: "half-written note" } });
    first.unmount();
    render(<Box id="case-1" />);
    expect((screen.getByLabelText("text") as HTMLInputElement).value).toBe("half-written note");
    fireEvent.click(screen.getByText("sent"));
    expect((screen.getByLabelText("text") as HTMLInputElement).value).toBe("start");
    expect(window.localStorage.getItem("ist_draft:case-1")).toBeNull();
  });

  it("keeps drafts for different cases apart, and does not store an unchanged default", () => {
    render(<Box id="case-a" />);
    expect(window.localStorage.getItem("ist_draft:case-a")).toBeNull();
    fireEvent.change(screen.getByLabelText("text"), { target: { value: "for A" } });
    expect(window.localStorage.getItem("ist_draft:case-a")).toBe("for A");
    expect(window.localStorage.getItem("ist_draft:case-b")).toBeNull();
  });
});
