/**
 * Single-process launcher for Render (or local).
 * Starts API, scheduler, worker, dispatcher as child processes.
 */
import { spawn } from "node:child_process";
import path from "node:path";

const dist = path.resolve(__dirname, "..");

function start(name: string, entry: string): void {
  const child = spawn(process.execPath, [path.join(dist, entry)], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    console.error(`${name} exited code=${code} signal=${signal}`);
    process.exit(code ?? 1);
  });
  console.log(`started ${name}`);
}

start("api", "src/main.js");
start("scheduler", "src/scheduler/main.js");
start("worker", "src/worker/main.js");
start("dispatcher", "src/dispatcher/main.js");
