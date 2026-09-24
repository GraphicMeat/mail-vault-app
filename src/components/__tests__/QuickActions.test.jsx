// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QuickActions } from "../QuickActions";

const icon = () => <span aria-hidden="true">•</span>;
const descriptors = [
  {
    id: "archive",
    action: "archive",
    label: "Archive",
    Icon: icon,
    onActivate: vi.fn(),
  },
  {
    id: "reply",
    action: "reply",
    label: "Reply",
    Icon: icon,
    onActivate: vi.fn(),
  },
  {
    id: "delete",
    action: "delete",
    label: "Delete",
    Icon: icon,
    onActivate: vi.fn(),
    tone: "danger",
  },
];
const config = (mode, entries = descriptors, favoriteId = "archive") => ({
  mode,
  entries: entries.map(({ id, action }) => ({ id, action })),
  favoriteId,
  palette: "neutral",
});

afterEach(() => {
  cleanup();
  descriptors.forEach((item) => item.onActivate.mockClear());
});

describe("QuickActions", () => {
  it("renders configured entries in order and applies custom colors without replacing labels", () => {
    const { rerender } = render(
      <QuickActions
        config={{
          ...config("inline"),
          palette: "custom",
          entries: [
            { id: "reply", action: "reply", color: "#123456" },
            { id: "archive", action: "archive" },
          ],
        }}
        descriptors={descriptors}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Reply",
      "Archive",
    ]);
    expect(buttons[0].style.getPropertyValue("--quick-action-color")).toBe(
      "#123456",
    );
  });

  it("opens a menu and supports arrow, Home, and End navigation", () => {
    render(<QuickActions config={config("menu")} descriptors={descriptors} />);
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("runs an action once, stops row activation, and restores focus after dismissal", async () => {
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <QuickActions
          config={config("favorite-menu")}
          descriptors={descriptors}
        />
      </div>,
    );
    const favorite = screen.getByRole("button", { name: "Archive" });
    fireEvent.click(favorite);
    expect(descriptors[0].onActivate).toHaveBeenCalledOnce();
    expect(parentClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Quick actions" }),
      )
    );
  });

  // A right-click on a row opens the row's actions at the pointer. Inline
  // mode draws some of them on the row already; the pointer menu offers all.
  it("opens every configured action at the pointer, once per right-click", async () => {
    const at = { x: 40, y: 60 };
    const { rerender } = render(
      <QuickActions config={config("inline")} descriptors={descriptors} inlineLimit={1} openAt={at} />,
    );
    const menu = screen.getByRole("menu");
    expect(menu.style.top).toBe("60px");
    expect(menu.style.left).toBe("40px");
    expect(screen.getAllByRole("menuitem").map((item) => item.getAttribute("aria-label")))
      .toEqual(["Archive", "Reply", "Delete"]);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // The same point again is a re-render, not a second right-click.
    rerender(<QuickActions config={config("inline")} descriptors={descriptors} inlineLimit={1} openAt={at} />);
    expect(screen.queryByRole("menu")).toBeNull();
    rerender(<QuickActions config={config("inline")} descriptors={descriptors} inlineLimit={1} openAt={{ x: 40, y: 60 }} />);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("uses a safe favorite fallback when the saved favorite is unavailable", () => {
    render(
      <QuickActions
        config={{ ...config("favorite-menu", descriptors, "missing") }}
        descriptors={descriptors}
      />,
    );
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("allows an explicitly chosen destructive favorite to route through its guarded handler", () => {
    render(
      <QuickActions
        config={config("favorite-menu", descriptors, "delete")}
        descriptors={descriptors}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(descriptors[2].onActivate).toHaveBeenCalledOnce();
  });

  it("does not substitute a different saved template or folder for a missing parameterized entry", () => {
    const parameterized = [
      {
        id: "replyTemplate:template-1",
        action: "replyTemplate",
        label: "Template one",
        Icon: icon,
        onActivate: vi.fn(),
      },
      {
        id: "move:account-a:Archive",
        action: "move",
        label: "Move to Archive",
        Icon: icon,
        onActivate: vi.fn(),
      },
    ];
    render(
      <QuickActions
        config={{
          mode: "inline",
          favoriteId: null,
          palette: "neutral",
          entries: [
            {
              id: "replyTemplate:template-2",
              action: "replyTemplate",
              params: { templateId: "template-2" },
            },
            {
              id: "move:account-b:Archive",
              action: "move",
              params: { accountId: "account-b", mailbox: "Archive" },
            },
          ],
        }}
        descriptors={parameterized}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      parameterized.every((item) => item.onActivate.mock.calls.length === 0),
    ).toBe(true);
  });

  it("keeps unavailable actions disabled and offers radial actions through keyboard", () => {
    const unavailable = [{
      id: "reply",
      action: "reply",
      label: "Reply",
      Icon: icon,
      disabled: true,
    }];
    render(
      <QuickActions
        config={config("radial", unavailable)}
        descriptors={unavailable}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Reply" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps a single wheel for many actions unless pagination is enabled", () => {
    const many = Array.from(
      { length: 10 },
      (_, index) => ({
        id: `action-${index}`,
        action: "archive",
        label: `Action ${index}`,
        Icon: icon,
        onActivate: vi.fn(),
      }),
    );
    const entries = many.map(({ id, action }) => ({ id, action }));
    const { rerender } = render(
      <QuickActions
        config={{ mode: "radial", palette: "semantic", entries }}
        descriptors={many}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    expect(screen.getAllByRole("menuitem", { name: /Action/ })).toHaveLength(
      10,
    );

    rerender(
      <QuickActions
        config={{
          mode: "radial",
          palette: "semantic",
          radialPagination: true,
          entries,
        }}
        descriptors={many}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    expect(screen.queryByRole("menuitem", { name: "Action 9" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Next actions" }));
    expect(screen.getByRole("menuitem", { name: "Action 9" })).toBeTruthy();
  });

  it("moves focus to the first action on a newly selected preview wheel page", async () => {
    const many = Array.from(
      { length: 10 },
      (_, index) => ({
        id: `preview-${index}`,
        action: "archive",
        label: `Preview ${index}`,
        Icon: icon,
        onActivate: vi.fn(),
      }),
    );
    render(
      <QuickActions
        config={{
          mode: "radial",
          palette: "semantic",
          radialPagination: true,
          entries: many.map(({ id, action }) => ({ id, action })),
        }}
        descriptors={many}
        preview
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Next actions" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: "Preview 8" }),
      )
    );
  });

  it("keeps colors stable when actions are reordered and puts inline overflow in a reachable menu", () => {
    const overflow = [...descriptors, {
      id: "forward",
      action: "forward",
      label: "Forward",
      Icon: icon,
      onActivate: vi.fn(),
    }];
    const base = {
      mode: "inline",
      palette: "semantic",
      entries: overflow.map(({ id, action }) => ({ id, action })),
    };
    const { rerender } = render(
      <QuickActions config={base} descriptors={overflow} inlineLimit={2} />,
    );
    const archiveColor = screen.getByRole("button", { name: "Archive" }).style
      .getPropertyValue("--quick-action-color");
    expect(screen.getByRole("button", { name: "Quick actions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Forward" }));
    expect(overflow[3].onActivate).toHaveBeenCalledOnce();

    rerender(
      <QuickActions
        config={{ ...base, entries: [...base.entries].reverse() }}
        descriptors={overflow}
        inlineLimit={4}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Archive" }).style.getPropertyValue(
        "--quick-action-color",
      ),
    ).toBe(archiveColor);
  });

  it("fits selection actions to measured space while retaining every action in overflow", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function measuredRect() {
        return {
          width: this.classList?.contains("quick-action-button") ? 100 : 32,
          height: 32,
          top: 0,
          left: 0,
          right: 100,
          bottom: 32,
          x: 0,
          y: 0,
          toJSON() {},
        };
      });
    const actions = [...descriptors, {
      id: "forward",
      action: "forward",
      label: "Forward",
      Icon: icon,
      onActivate: vi.fn(),
    }];
    const { rerender } = render(
      <QuickActions
        surface="selection"
        config={{
          mode: "inline",
          palette: "semantic",
          entries: actions.map(({ id, action }) => ({ id, action })),
        }}
        descriptors={actions}
        inlineLimit={6}
        inlineAvailableWidth={150}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Archive" })).toHaveLength(1)
    );
    expect(screen.getByRole("button", { name: "Quick actions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    expect(screen.getByRole("menuitem", { name: "Forward" })).toBeTruthy();
    rerender(
      <QuickActions
        surface="selection"
        config={{
          mode: "inline",
          palette: "semantic",
          entries: actions.map(({ id, action }) => ({ id, action })),
        }}
        descriptors={actions}
        inlineLimit={6}
        inlineAvailableWidth={500}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Quick actions" })).toBeNull()
    );
    rect.mockRestore();
  });
});
