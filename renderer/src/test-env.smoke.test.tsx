import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { useSettingsStore } from "./stores/settingsStore";

function Probe() {
  const theme = useSettingsStore((s) => s.theme);
  return <div>theme:{theme}</div>;
}

describe("test env smoke", () => {
  it("renders a component calling useSettingsStore", () => {
    render(<Probe />);
    expect(screen.getByText("theme:dark")).toBeInTheDocument();
  });
});
