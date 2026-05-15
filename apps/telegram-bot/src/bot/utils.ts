export function createId(prefix?: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    const id = crypto.randomUUID();
    return prefix ? `${prefix}-${id}` : id;
  }

  const fallback =
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10) +
    "-" +
    Math.random().toString(36).slice(2, 10);

  return prefix ? `${prefix}-${fallback}` : fallback;
}

type ErrorShape = {
  message?: unknown;
};

function isErrorShape(error: unknown): error is ErrorShape {
  return typeof error === "object" && error !== null;
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isErrorShape(error) && typeof error.message === "string") return error.message;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
