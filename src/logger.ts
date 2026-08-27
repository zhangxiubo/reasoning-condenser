export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const write = (level: "info" | "error", event: string, fields: Record<string, unknown> = {}): void => {
  const record = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
  const destination = level === "error" ? process.stderr : process.stdout;
  destination.write(`${record}\n`);
};

export const jsonLogger: Logger = {
  info: (event, fields) => write("info", event, fields),
  error: (event, fields) => write("error", event, fields),
};
