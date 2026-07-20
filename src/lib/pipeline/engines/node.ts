import type { PipelineEngine } from "../types";
import { resolveApiKey } from "@/lib/api-keys";
import {
  findScenesJson,
  loadScenesJsonFile,
  scenesHaveDescriptions,
} from "@/lib/scenes";
import { generatePrompts } from "../gemini/run";
import { syncPromptsFromScenes } from "../gemini/sync-prompts";
import { runFireflyRouter } from "../router/run-firefly";
import { runHailuoRouter } from "../router/run-hailuo";

export const nodeEngine: PipelineEngine = {
  name: "node",

  async runPromptGeneration(opts) {
    const apiKey = resolveApiKey("GEMINI_API_KEY", opts.env);
    const scenesFile = findScenesJson(opts.projectPath);
    const scenes = scenesFile ? loadScenesJsonFile(scenesFile) : [];

    if (scenesHaveDescriptions(scenes)) {
      return syncPromptsFromScenes({
        projectPath: opts.projectPath,
        keyframesSource: opts.keyframesSource,
        scenesFilter: opts.scenes,
        apiKey,
      });
    }

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
