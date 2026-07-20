import fs from "fs";
import path from "path";

export type SceneRecord = Record<string, unknown>;

export type Job = {
  scene: SceneRecord;
  variant: string;
  prompt: string;
  startImage: string | null;
  endImage: string | null;
  outPath: string;
  duration: number;
  videoDir: string;
  resolution?: string | null;
  onSubmit?: (vidId: string) => void | Promise<void>;
  resumeVidId?: string | null;
  outName?: string;
  submitMeta?: Record<string, unknown>;
  skipQueueGate?: boolean;
  preGenerate?: () => void | Promise<void>;
  promptOptimizer?: boolean;
};

export function jobLabel(job: Job): string {
  return String(job.scene.label || `scene_${job.scene.index ?? 0}`);
}

export type AdapterSpec = {
  key: string;
  provider: string;
  modelTag: string;
  modes: Set<string>;
  ready: boolean;
  generate: (job: Job) => Promise<string>;
  description?: string;
};

const registry = new Map<string, AdapterSpec>();

export function register(spec: AdapterSpec): AdapterSpec {
  if (registry.has(spec.key)) {
    throw new Error(`Adaptor anahtarı çakıştı: ${spec.key}`);
  }
  registry.set(spec.key, spec);
  return spec;
}

export function getAdapter(key: string): AdapterSpec {
  const spec = registry.get(key);
  if (!spec) {
    throw new Error(`Kayıtlı olmayan adaptor: ${key} (kayıtlı: ${[...registry.keys()].sort()})`);
  }
  return spec;
}

export function allAdapters(): Map<string, AdapterSpec> {
  return new Map(registry);
}

export function sleepBetween(lo = 4, hi = 8, why = "", log = console.log) {
  const wait = lo + Math.random() * (hi - lo);
  const tail = why ? ` (${why})` : "";
  log(`   .. ${wait.toFixed(1)}s bekleniyor${tail}`);
  return new Promise((r) => setTimeout(r, wait * 1000));
}

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; backoffs?: number[]; label?: string; log?: (s: string) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const backoffs = opts.backoffs ?? [5, 15, 45];
  const log = opts.log ?? console.log;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const status = (e as { status?: number }).status;
      if (status !== undefined && !TRANSIENT_STATUS.has(status)) throw e;
      if (i < attempts - 1) {
        const wait = backoffs[Math.min(i, backoffs.length - 1)];
        log(
          `   [retry ${opts.label || ""}] geçici hata: ${e instanceof Error ? e.name : e} — ${wait}s sonra (${i + 2}/${attempts}. deneme)`,
        );
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
  }
  throw last;
}

export interface OutputSink {
  localPath(name: string): string;
  exists(name: string): boolean;
  finalize(localPath: string): string;
  describe(): string;
}

export class LocalSink implements OutputSink {
  constructor(private root: string) {}

  localPath(name: string): string {
    fs.mkdirSync(this.root, { recursive: true });
    return path.join(this.root, name);
  }

  exists(name: string): boolean {
    const p = path.join(this.root, name);
    try {
      return fs.statSync(p).size > 0;
    } catch {
      return false;
    }
  }

  finalize(localPath: string): string {
    return localPath;
  }

  describe(): string {
    return `LocalSink(${this.root})`;
  }
}
