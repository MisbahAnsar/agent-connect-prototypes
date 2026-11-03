import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunnerState, StateStore } from "./store";

/** JSON file store; writes via temp file + rename so a crash never leaves a torn file. */
export class FileStateStore implements StateStore {
  constructor(private path: string) {}

  async load(): Promise<RunnerState> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as RunnerState;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { banked: false };
      throw e;
    }
  }

  async save(state: RunnerState) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, this.path);
  }
}
