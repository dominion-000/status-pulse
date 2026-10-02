import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/core/clock";
import { isCurrentSlot, slotStart } from "../../src/core/slots";

describe("slotStart (SP-03.1)", () => {
  it("gives every instant within an interval the same slot", () => {
    const a = slotStart(new Date("2026-10-01T10:00:07.250Z"), 60);
    const b = slotStart(new Date("2026-10-01T10:00:59.999Z"), 60);
    expect(a.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(b.getTime()).toBe(a.getTime());
  });

  it("starts a new slot exactly at the boundary", () => {
    expect(slotStart(new Date("2026-10-01T10:01:00.000Z"), 60).toISOString()).toBe("2026-10-01T10:01:00.000Z");
  });

  it.each([30, 60, 300, 600])("aligns to the epoch for a %i second interval", (interval) => {
    const slot = slotStart(new Date("2026-10-01T10:07:43Z"), interval);
    expect((slot.getTime() / 1000) % interval).toBe(0);
  });
});

describe("isCurrentSlot (SP-03.7)", () => {
  it("is true only while the slot is the current one", () => {
    const clock = fixedClock(new Date("2026-10-01T10:00:10Z"));
    const slot = slotStart(clock.now(), 60);
    expect(isCurrentSlot(slot, clock.now(), 60)).toBe(true);
    clock.advance(49_000);
    expect(isCurrentSlot(slot, clock.now(), 60)).toBe(true);
    clock.advance(1_000);
    expect(isCurrentSlot(slot, clock.now(), 60)).toBe(false);
  });
});

describe("fixedClock", () => {
  it("only moves when advanced", () => {
    const clock = fixedClock(new Date("2026-01-01T00:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.500Z");
  });
});
