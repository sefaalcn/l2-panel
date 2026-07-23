import fs from "fs";
import path from "path";
import { RUNSTATE_PATH, PANEL_DIR } from "./config";

export type RunState = {
  pid?: number;
  project?: string;
  provider?: string;
  status?: string;
  started_at?: number;
  updated_at?: number;
  error?: string;
  rc?: number;
};

const RUNS_DIR = path.join(PANEL_DIR, "runs");

export function safeRunId(project: string): string {
  return (project || "project").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100);
}

export function runstatePathFor(project: string): string {
  return path.join(RUNS_DIR, `${safeRunId(project)}.json`);
}

function readJson(file: string): RunState | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as RunState;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, data: RunState) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** Eski tek-dosya runstate'i okur (geçiş). */
export function readRunstate(project?: string): RunState | null {
  if (project) return readJson(runstatePathFor(project));
  // Legacy: global dosya veya ilk aktif
  const legacy = readJson(RUNSTATE_PATH);
  if (legacy?.project) {
    const modern = readJson(runstatePathFor(legacy.project));
    if (modern) return modern;
    return legacy;
  }
  const all = listRunstates();
  return all[0] || null;
}

export function listRunstates(): RunState[] {
  const out: RunState[] = [];
  try {
    if (fs.existsSync(RUNS_DIR)) {
      for (const name of fs.readdirSync(RUNS_DIR)) {
        if (!name.endsWith(".json")) continue;
        const rs = readJson(path.join(RUNS_DIR, name));
        if (rs) out.push(rs);
      }
    }
  } catch {
    /* */
  }
  // Legacy dosya
  const legacy = readJson(RUNSTATE_PATH);
  if (legacy?.project && !out.some((r) => r.project === legacy.project)) {
    out.push(legacy);
  }
  return out;
}

export function writeRunstate(d: RunState) {
  const project = String(d.project || "").trim();
  if (!project) {
    // project yoksa legacy'ye yaz (eski çağrılar)
    const prev = readJson(RUNSTATE_PATH) || {};
    writeJsonAtomic(RUNSTATE_PATH, {
      ...prev,
      ...d,
      updated_at: Date.now() / 1000,
    });
    return;
  }
  const file = runstatePathFor(project);
  const prev = readJson(file) || {};
  const merged: RunState = {
    ...prev,
    ...d,
    project,
    updated_at: Date.now() / 1000,
  };
  writeJsonAtomic(file, merged);
  // Panel/progress uyumu: "son aktif" olarak legacy'yi de güncelle
  writeJsonAtomic(RUNSTATE_PATH, merged);
}

export function clearRunstate(project?: string) {
  if (project) {
    try {
      fs.unlinkSync(runstatePathFor(project));
    } catch {
      /* */
    }
    const legacy = readJson(RUNSTATE_PATH);
    if (legacy?.project === project) {
      try {
        fs.unlinkSync(RUNSTATE_PATH);
      } catch {
        /* */
      }
    }
    return;
  }
  try {
    fs.unlinkSync(RUNSTATE_PATH);
  } catch {
    /* */
  }
  try {
    if (fs.existsSync(RUNS_DIR)) {
      for (const name of fs.readdirSync(RUNS_DIR)) {
        if (name.endsWith(".json")) {
          try {
            fs.unlinkSync(path.join(RUNS_DIR, name));
          } catch {
            /* */
          }
        }
      }
    }
  } catch {
    /* */
  }
}

export function pidAlive(pid?: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Bu proje için canlı koşu */
export function getActiveRun(project: string): RunState | null {
  const rs = readRunstate(project);
  if (rs && pidAlive(rs.pid)) return rs;
  if (rs) clearRunstate(project);
  return null;
}

/** Herhangi bir canlı koşu (eski API). */
export function activeRun(): RunState | null {
  for (const rs of listRunstates()) {
    if (pidAlive(rs.pid)) return rs;
    if (rs.project) clearRunstate(rs.project);
  }
  return null;
}

export function listActiveRuns(): RunState[] {
  const out: RunState[] = [];
  for (const rs of listRunstates()) {
    if (pidAlive(rs.pid)) out.push(rs);
    else if (rs.project) clearRunstate(rs.project);
  }
  return out;
}

export function cleanCredFiles(project?: string) {
  const prefix = project ? `.l2_${safeRunId(project)}_` : ".l2_";
  const names = project
    ? [
        `${prefix}token.txt`,
        `${prefix}cookie.txt`,
        `${prefix}project.txt`,
        `${prefix}ff_token.txt`,
        `${prefix}ff_arp.txt`,
        `${prefix}ff_nonce.txt`,
        `${prefix}gemini_api_key.txt`,
        `${prefix}anthropic_api_key.txt`,
      ]
    : [
        ".l2_token.txt",
        ".l2_cookie.txt",
        ".l2_project.txt",
        ".l2_ff_token.txt",
        ".l2_ff_arp.txt",
        ".l2_ff_nonce.txt",
        ".l2_gemini_api_key.txt",
        ".l2_anthropic_api_key.txt",
      ];
  for (const name of names) {
    try {
      fs.unlinkSync(path.join(PANEL_DIR, name));
    } catch {
      /* */
    }
  }
  // Eski global staged (yalnız project verilmediyse)
  if (!project) {
    try {
      if (fs.existsSync(PANEL_DIR)) {
        for (const name of fs.readdirSync(PANEL_DIR)) {
          if (/^\.l2_.+_ff_token\.txt$/.test(name) || /^\.l2_.+_token\.txt$/.test(name)) {
            try {
              fs.unlinkSync(path.join(PANEL_DIR, name));
            } catch {
              /* */
            }
          }
        }
      }
    } catch {
      /* */
    }
  }
}
