import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { NormalizedTurn } from "./types.ts";

export interface ArchivedTurn {
  recorded_at: string;
  public_model: string;
  turn: NormalizedTurn;
}

export interface TurnArchive {
  append(record: ArchivedTurn): Promise<void>;
}

export class NullTurnArchive implements TurnArchive {
  async append(): Promise<void> {}
}

export class JsonLinesTurnArchive implements TurnArchive {
  readonly path: string;
  private append_sequence: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async append(record: ArchivedTurn): Promise<void> {
    const operation = this.append_sequence.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    this.append_sequence = operation.catch(() => undefined);
    await operation;
  }
}

export const createTurnArchive = (path: string | undefined): TurnArchive =>
  path ? new JsonLinesTurnArchive(path) : new NullTurnArchive();
