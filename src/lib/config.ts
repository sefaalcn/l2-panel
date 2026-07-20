import path from "path";

export const CODE_ROOT = path.resolve(process.env.L2_CODE_ROOT || process.cwd());
export const PROJECTS_ROOT = path.resolve(
  process.env.L2_PROJECTS_ROOT || path.join(CODE_ROOT, "projects"),
);
export const PANEL_DIR = path.join(CODE_ROOT, "l2_panel");
export const RUNSTATE_PATH = path.join(PANEL_DIR, ".l2_active_run.json");

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
        label: "Prompt Optimizer",
        type: "toggle",
        default: true,
        note: "Açık=optimize. Kapalı=verbatim (--no-optimizer).",
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
        label: "Firefly Token (Bearer)",
        target: { type: "file", name: "firefly_token.txt", env: "FIREFLY_TOKEN_FILE" },
        secret: true,
        required: true,
      },
      {
        key: "ff_arp",
        label: "arp (opsiyonel)",
        target: { type: "file", name: "firefly_arp.txt", env: "FIREFLY_ARP_FILE" },
        secret: true,
        required: false,
        autoFromFile: true,
      },
      {
        key: "ff_nonce",
        label: "nonce (opsiyonel)",
        target: { type: "file", name: "firefly_nonce.txt", env: "FIREFLY_NONCE_FILE" },
        secret: true,
        required: false,
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
