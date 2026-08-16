export type LogLevel = "info" | "warn" | "error";

export class JsonLogger {
  log(
    level: LogLevel,
    event: string,
    fields: Record<string, string | number | boolean | undefined> = {},
  ): void {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      ),
    };
    const serialized = `${JSON.stringify(record)}\n`;
    if (level === "error") process.stderr.write(serialized);
    else process.stdout.write(serialized);
  }
}

export const logger = new JsonLogger();
