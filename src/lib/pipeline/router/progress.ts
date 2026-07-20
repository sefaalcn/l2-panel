import fs from "fs";
import path from "path";

export type ProgressRecord = Record<string, unknown>;

export function loadProgress(filePath: string): Record<string, ProgressRecord> {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, ProgressRecord>;
    }
  } catch {
    /* */
  }
  return {};
}

export function saveProgress(filePath: string, data: Record<string, ProgressRecord>) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* */
    }
  }
}

/** Tek yazıcı — async mutex ile paralel-güvenli */
export class ProgressStore {
  private data: Record<string, ProgressRecord>;
  private chain: Promise<void> = Promise.resolve();

  constructor(private filePath: string) {
    this.data = loadProgress(filePath);
  }

  private run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  update(key: string, record: ProgressRecord) {
    return this.run(() => {
      this.data[key] = record;
      saveProgress(this.filePath, this.data);
    });
  }

  setSubmitted(key: string, vidId: string, meta?: Record<string, unknown>) {
    return this.run(() => {
      const rec = { ...(meta || {}), status: "submitted", vid_id: vidId };
      this.data[key] = rec;
      saveProgress(this.filePath, this.data);
    });
  }

  recordFailure(key: string, record: ProgressRecord) {
    return this.run(() => {
      const prev = this.data[key];
      if (prev?.vid_id && !record.vid_id) {
        record = { ...record, vid_id: prev.vid_id };
      }
      this.data[key] = record;
      saveProgress(this.filePath, this.data);
    });
  }

  get(key: string): ProgressRecord | undefined {
    return this.data[key];
  }

  snapshot(): Record<string, ProgressRecord> {
    return { ...this.data };
  }
}
