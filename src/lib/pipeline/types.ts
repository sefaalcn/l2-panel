import type { KeyframesSource } from "@/lib/ingest";

export type { KeyframesSource };

export type RunPhase =
  | "basliyor"
  | "prompt_uretiliyor"
  | "video_uretiliyor"
  | "bitti"
  | "hata";

export type PipelineEngineName = "node";

export interface RunOptions {
  projectPath: string;
  provider: string;
  variants: string;
  concurrency?: number | null;
  scenes?: string | null;
  noOptimizer?: boolean;
  keyframesSource: KeyframesSource;
  logPath: string;
  env: NodeJS.ProcessEnv;
}

export interface PipelineEngine {
  readonly name: PipelineEngineName;
  runPromptGeneration(opts: RunOptions, projectName: string): Promise<number>;
  runVideoProduction(opts: RunOptions, projectName: string): Promise<number>;
}
