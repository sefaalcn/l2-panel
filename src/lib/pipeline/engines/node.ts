import type { PipelineEngine } from "../types";
import fs from "fs";
import path from "path";
import { resolveApiKey } from "@/lib/api-keys";
import { withProviderLock } from "@/lib/provider-lock";
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
    const apiKey = resolveApiKey("GEMINI_API_KEY", opts.env) || "";
    const scenesFile = findScenesJson(opts.projectPath);
    const scenes = scenesFile ? loadScenesJsonFile(scenesFile) : [];
    const project = path.basename(opts.projectPath);
    const log = (s: string) => {
      try {
        fs.appendFileSync(opts.logPath, `${s}\n`, "utf8");
      } catch {
        /* */
      }
      console.log(s);
    };

    return withProviderLock("gemini", project, log, () =>
      generatePrompts({
        projectPath: opts.projectPath,
        keyframesSource: opts.keyframesSource,
        scenesFilter: opts.scenes,
        apiKey,
        useSceneDescAsV3: scenesHaveDescriptions(scenes),
        forceRegenerate: Boolean(opts.regeneratePrompts),
      }),
    );
  },

  async runVideoProduction(opts, _projectName) {
    if (opts.provider === "firefly") {
      return runFireflyRouter(opts);
    }
    return runHailuoRouter(opts);
  },
};
