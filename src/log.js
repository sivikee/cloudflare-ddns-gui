// Small in-memory ring buffer for the activity log shown in the GUI.
// Intentionally not persisted: history resetting on restart is fine for this.

const MAX_ENTRIES = 200;
const entries = [];

export function push(level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();

  const line = `[${entry.ts}] ${level.toUpperCase()} ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);

  return entry;
}

export const info = (message) => push("info", message);
export const warn = (message) => push("warn", message);
export const error = (message) => push("error", message);

export function recent(limit = 50) {
  return entries.slice(-limit);
}
