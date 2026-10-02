/**
 * Single-process launcher for the shared Render (or local) environment.
 * Starts API, scheduler and worker as child processes.
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

start("api", "main.js");
start("scheduler", "scheduler/main.js");
start("worker", "worker/main.js");
