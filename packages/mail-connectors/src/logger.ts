/**
 * Pino-compatible logger shape. Connectors only log ids, counters and error codes –
 * never message content, addresses, subjects or credentials.
 */
export interface ConnectorLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

const noop = (): void => {};

export const noopLogger: ConnectorLogger = { debug: noop, info: noop, warn: noop, error: noop };
