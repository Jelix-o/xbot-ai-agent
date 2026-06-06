export function logInfo(message: string, details?: Record<string, unknown>): void {
  writeLog("info", message, details);
}

export function logWarn(message: string, details?: Record<string, unknown>): void {
  writeLog("warn", message, details);
}

export function logError(message: string, details?: Record<string, unknown>): void {
  writeLog("error", message, details);
}

function writeLog(level: "info" | "warn" | "error", message: string, details?: Record<string, unknown>): void {
  const payload = {
    level,
    message,
    time: new Date().toISOString(),
    ...(details ? { details } : {}),
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
