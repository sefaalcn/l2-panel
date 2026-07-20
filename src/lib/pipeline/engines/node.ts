import type { PipelineEngine } from "../types";
import { generatePrompts } from "../gemini/run";
import { runFireflyRouter } from "../router/run-firefly";
import { runHailuoRouter } from "../router/run-hailuo";

export const nodeEngine: PipelineEngine = {
  name: "node",

  async runPromptGeneration(opts) {
    const apiKey = String(opts.env.GEMINI_API_KEY || "").trim();
    return generatePrompts({
      projectPath: opts.projectPath,
      keyframesSource: opts.keyframesSource,
      scenesFilter: opts.scenes,
      apiKey,
    });
  },

  async runVideoProduction(opts, _projectName) {
    if (opts.provider === "firefly") {
      return runFireflyRouter(opts);
    }
    return runHailuoRouter(opts);
  },
};
