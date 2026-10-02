/** Typed application errors mapped to the API error envelope. */

export type ErrorCode =
  | "VALIDATION"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function validationError(message: string, details?: unknown): AppError {
  return new AppError("VALIDATION", message, 422, details);
}

export function conflictError(message: string): AppError {
  return new AppError("CONFLICT", message, 409);
}

export function unauthorizedError(message = "Authentication required"): AppError {
  return new AppError("UNAUTHORIZED", message, 401);
}

export function forbiddenError(message = "Insufficient permissions"): AppError {
  return new AppError("FORBIDDEN", message, 403);
}

export function notFoundError(message = "Not found"): AppError {
  return new AppError("NOT_FOUND", message, 404);
}
