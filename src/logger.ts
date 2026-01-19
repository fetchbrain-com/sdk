import type { Logger, LogLevel } from "./types";

// ANSI color codes
const COLORS = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: COLORS.gray,
  info: COLORS.green,
  warn: COLORS.yellow,
  error: COLORS.red,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

/**
 * Creates a logger with the specified minimum level
 * Matches Crawlee log style: "INFO  FetchBrain: message"
 */
export function createLogger(
  minLevel: LogLevel = "info",
  enabled = true,
): Logger {
  const shouldLog = (level: LogLevel): boolean => {
    if (!enabled) return false;
    return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
  };

  const formatLog = (level: LogLevel, message: string): string => {
    const levelColor = LEVEL_COLORS[level];
    const label = LEVEL_LABELS[level];
    return `${levelColor}${label}${COLORS.reset} ${COLORS.cyan}FetchBrain:${COLORS.reset} ${message}`;
  };

  return {
    debug: (message: string, ...args: unknown[]) => {
      if (shouldLog("debug")) {
        console.debug(formatLog("debug", message), ...args);
      }
    },
    info: (message: string, ...args: unknown[]) => {
      if (shouldLog("info")) {
        console.info(formatLog("info", message), ...args);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      if (shouldLog("warn")) {
        console.warn(formatLog("warn", message), ...args);
      }
    },
    error: (message: string, ...args: unknown[]) => {
      if (shouldLog("error")) {
        console.error(formatLog("error", message), ...args);
      }
    },
  };
}
