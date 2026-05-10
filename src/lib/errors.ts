type ErrorShape = {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
  name?: unknown;
};

function isErrorShape(error: unknown): error is ErrorShape {
  return typeof error === "object" && error !== null;
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (isErrorShape(error) && typeof error.message === "string") {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function logAppError(label: string, error: unknown) {
  const errorShape = isErrorShape(error) ? error : {};

  console.error(label, {
    message: getErrorMessage(error),
    code: errorShape.code,
    details: errorShape.details,
    hint: errorShape.hint,
  });
}
