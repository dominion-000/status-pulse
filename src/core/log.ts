/**
 * System logging with Winston (API, scheduler, worker, dispatcher).
 * HTTP access lines stay on Morgan — see src/logging.ts.
 */
import winston from "winston";

const level = (process.env.LOG_LEVEL ?? "info").toLowerCase();

export const log = winston.createLogger({
  level: [
    "error",
    "warn",
    "info",
    "http",
    "verbose",
    "debug",
    "silly",
  ].includes(level)
    ? level
    : "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: {
    service: "status-pulse",
    process: process.env.PROCESS_NAME ?? "unknown",
  },
  transports: [new winston.transports.Console()],
});

export function logWithProcess(processName: string): winston.Logger {
  return log.child({ process: processName });
}
