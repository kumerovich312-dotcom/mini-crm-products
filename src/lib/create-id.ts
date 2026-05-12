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
