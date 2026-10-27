/**
 * Register SIGINT and SIGTERM handlers that run once, then exit.
 * Used by all four processes (API, scheduler, worker, dispatcher).
 */
export function onGracefulShutdown(
  label: string,
  cleanup: () => Promise<void>,
): void {
  let stopping = false;

  const run = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${label}: shutting down on ${signal}`);
    void (async () => {
      try {
        await cleanup();
      } catch (err) {
        console.error(`${label}: shutdown error`, err);
      } finally {
        process.exit(0);
      }
    })();
  };

  process.on("SIGINT", () => run("SIGINT"));
  process.on("SIGTERM", () => run("SIGTERM"));
}
