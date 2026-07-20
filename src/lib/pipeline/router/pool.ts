import type { AdapterSpec, Job } from "./core";
import type { ProgressStore } from "./progress";

export type JobResult = {
  job: PoolJob;
  ok: boolean;
  path?: string;
  error?: string;
  usedSpec?: AdapterSpec;
  meta?: Record<string, unknown>;
};

export type PoolJob = Job & {
  _spec?: AdapterSpec;
  _mode?: string;
  outName?: string;
  submitMeta?: Record<string, unknown>;
};

export type ProduceFn = (job: PoolJob) => Promise<{
  path: string;
  usedSpec: AdapterSpec;
  meta: Record<string, unknown>;
}>;

export class Pool {
  private lastGenerate = 0;
  private gateLock: Promise<void> = Promise.resolve();

  constructor(
    public concurrency: number,
    private store: ProgressStore,
    private pacing: [number, number] = [20, 60],
  ) {
    this.concurrency = Math.max(1, concurrency);
  }

  private async gate() {
    const [lo, hi] = this.pacing;
    let release!: () => void;
    const waitTurn = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.gateLock;
    this.gateLock = waitTurn;
    await prev;

    try {
      if (hi > 0) {
        const wait = lo + Math.floor(Math.random() * (hi - lo + 1));
        if (this.lastGenerate) {
          const elapsed = (Date.now() - this.lastGenerate) / 1000;
          if (elapsed < wait) {
            await new Promise((r) => setTimeout(r, (wait - elapsed) * 1000));
          }
        }
      }
      this.lastGenerate = Date.now();
    } finally {
      release();
    }
  }

  private async work(job: PoolJob, produce: ProduceFn): Promise<JobResult> {
    job.skipQueueGate = true;
    job.preGenerate = () => this.gate();
    job.onSubmit = async (vid) => {
      await this.store.setSubmitted(job.outName!, vid, job.submitMeta || {});
    };
    const base = { ...(job.submitMeta || {}) };
    try {
      const { path, usedSpec, meta } = await produce(job);
      const rec = { ...base, status: "done", ...meta };
      await this.store.update(job.outName!, rec);
      return { job, ok: true, path, usedSpec, meta };
    } catch (e) {
      const rec = { ...base, status: "error", error: String(e) };
      await this.store.recordFailure(job.outName!, rec);
      return { job, ok: false, error: String(e) };
    }
  }

  async run(
    jobs: PoolJob[],
    produce: ProduceFn,
    onResult?: (r: JobResult) => void,
  ): Promise<JobResult[]> {
    const results: JobResult[] = [];
    if (this.concurrency === 1) {
      for (const job of jobs) {
        const r = await this.work(job, produce);
        onResult?.(r);
        results.push(r);
      }
      return results;
    }

    let idx = 0;
    const worker = async () => {
      while (true) {
        const i = idx++;
        if (i >= jobs.length) break;
        const r = await this.work(jobs[i], produce);
        onResult?.(r);
        results.push(r);
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
    return results;
  }
}
