import path from "path";

export const CODE_ROOT = path.resolve(process.env.L2_CODE_ROOT || process.cwd());
export const PROJECTS_ROOT = path.resolve(
  process.env.L2_PROJECTS_ROOT || path.join(CODE_ROOT, "projects"),
);
export const PANEL_DIR = path.join(CODE_ROOT, "l2_panel");
export const RUNSTATE_PATH = path.join(PANEL_DIR, ".l2_active_run.json");

/** Scene Studio / JSON video_model → Firefly 3p adaptörleri (720p) */
export const FIREFLY_VIDEO_MODELS = [
  {
    id: "kling_3",
    aliases: ["kling_3_0", "kling_3_0_pro", "kling3", "kling_v3"],
    label: "Kling 3.0",
    resolution: "720p",
    adapter: "kling3.0",
    modes: ["start_only", "both", "end_only"],
  },
  {
    id: "ray_3_14_pro",
    aliases: ["ray_3_14", "ray314", "luma_ray_3_14"],
    label: "Ray 3.14",
    resolution: "720p",
    adapter: "ray3.14",
    modes: ["both", "end_only"],
  },
  {
    id: "kling_2_5_turbo",
    aliases: ["kling_25", "kling2_5"],
    label: "Kling 2.5 Turbo",
    resolution: "720p",
    adapter: "kling2.5",
    modes: ["start_only"],
  },
  {
    id: "runway_gen4_5",
    aliases: ["gen4_5", "runway_4_5"],
    label: "Runway Gen-4.5",
    resolution: "720p",
    adapter: "runway4.5",
    modes: ["start_only"],
  },
] as const;

export const MODELS = {
  hailuo: {
    label: "Hailuo",
    active: true,
    provider: "hailuo",
    credentials: [
      {
        key: "token",
        label: "Hailuo Token",
        target: { type: "file", name: "hailuo_token.txt", env: "HAILUO_TOKEN_FILE" },
        secret: true,
        required: true,
      },
      {
        key: "cookie",
        label: "Cookie",
        target: { type: "file", name: "hailuo_cookie.txt", env: "HAILUO_COOKIE_FILE" },
        secret: true,
        required: true,
        autoFromFile: true,
      },
      {
        key: "project",
        label: "Proje ID",
        target: { type: "file", name: "hailuo_project.txt", env: "HAILUO_PROJECT_FILE" },
        secret: false,
        required: true,
      },
    ],
    options: [
      {
        key: "prompt_optimizer",
        label: "Hailuo Prompt Optimizer",
        type: "toggle",
        default: true,
        note: "Hailuo sitesindeki Prompt Optimizer (API useOriginPrompt). Açık: Hailuo metni kendi iyileştirir — v1/v2 için. Kapalı: JSON aynen gider. v3 her zaman kapalı.",
      },
    ],
  },
  firefly: {
    label: "Firefly",
    active: true,
    provider: "firefly",
    credentials: [
      {
        key: "ff_token",
        label: "Firefly Curl (F12 → Copy as cURL)",
        target: { type: "file", name: "firefly_token.txt", env: "FIREFLY_TOKEN_FILE" },
        secret: true,
        required: true,
        autoFromFile: true,
      },
    ],
    options: [] as { key: string; label: string; type: string; default?: boolean; note?: string }[],
  },
} as const;

export const COMMON_ENV = [
  { key: "ANTHROPIC_API_KEY", label: "Anthropic Key (S4 soften — opsiyonel)", secret: true, required: false },
  { key: "GEMINI_API_KEY", label: "Gemini Key (prompt üretimi)", secret: true, required: false },
] as const;

/** Oturum anahtarları (process RAM). Serverless'ta instance-local. */
export const sessionKeys: Record<string, string> = {};
