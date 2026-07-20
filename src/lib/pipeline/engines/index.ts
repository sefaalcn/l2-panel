import type { PipelineEngine } from "../types";
import { nodeEngine } from "./node";

/** Faz 6: Python motoru kaldırıldı — tek motor Node/TS. */
export function getPipelineEngine(): PipelineEngine {
  return nodeEngine;
}

export { nodeEngine };
