import type { PipelineEngine } from "../types";
import { resolveApiKey } from "@/lib/api-keys";
import {
  findScenesJson,
  loadScenesJsonFile,
  scenesHaveDescriptions,
} from "@/lib/scenes";
import { generatePrompts } from "../gemini/run";
import { runFireflyRouter } from "../router/run-firefly";
import { runHailuoRouter } from "../router/run-hailuo";

export const nodeEngine: PipelineEngine = {
  name: "node",

  async runPromptGeneration(opts) {
    const apiKey = resolveApiKey("GEMINI_API_KEY", opts.env);
    if (!apiKey?.trim()) {
      console.error("❌ GEMINI_API_KEY gerekli (v1 optimize + v2 slow motion)");
      return 1;
    }
    const scenesFile = findScenesJson(opts.projectPath);
    const scenes = scenesFile ? loadScenesJsonFile(scenesFile) : [];

    return generatePrompts({
      projectPath: opts.projectPath,
      keyframesSource: opts.keyframesSource,
      scenesFilter: opts.scenes,
      apiKey,
      useSceneDescAsV3: scenesHaveDescriptions(scenes),
    });
  },

  async runVideoProduction(opts, _projectName) {
    if (opts.provider === "firefly") {
      return runFireflyRouter(opts);
    }
    return runHailuoRouter(opts);
  },
};
