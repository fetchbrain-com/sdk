import type { Logger, LogLevel } from './types';

const LOG_PREFIX = '[FetchBrain]';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Creates a logger with the specified minimum level
 */
export function createLogger(minLevel: LogLevel = 'info', enabled = true): Logger {
  const shouldLog = (level: LogLevel): boolean => {
    if (!enabled) return false;
    return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
  };

  return {
    debug: (message: string, ...args: unknown[]) => {
      if (shouldLog('debug')) {
        console.debug(`${LOG_PREFIX} ${message}`, ...args);
      }
    },
    info: (message: string, ...args: unknown[]) => {
      if (shouldLog('info')) {
        console.info(`${LOG_PREFIX} ${message}`, ...args);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      if (shouldLog('warn')) {
        console.warn(`${LOG_PREFIX} ${message}`, ...args);
      }
    },
    error: (message: string, ...args: unknown[]) => {
      if (shouldLog('error')) {
        console.error(`${LOG_PREFIX} ${message}`, ...args);
      }
    },
  };
}
