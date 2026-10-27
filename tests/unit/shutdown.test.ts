import { afterEach, describe, expect, it, vi } from "vitest";
import { onGracefulShutdown } from "../../src/core/shutdown";

describe("graceful shutdown (SP-NKPQ)", () => {
  const listeners: Record<string, Function[]> = {};

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of Object.keys(listeners)) delete listeners[k];
  });

  it("registers SIGINT and SIGTERM and runs cleanup once", async () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(((
      event: string,
      fn: Function,
    ) => {
      (listeners[event] ??= []).push(fn);
      return process;
    }) as typeof process.on);

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    const cleanup = vi.fn(async () => undefined);
    onGracefulShutdown("test", cleanup);

    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));

    listeners.SIGINT![0]!("SIGINT");
    await new Promise((r) => setTimeout(r, 20));
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    listeners.SIGTERM![0]!("SIGTERM");
    await new Promise((r) => setTimeout(r, 20));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
