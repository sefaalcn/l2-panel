import fs from "fs";
import path from "path";
import OSS from "ali-oss";
import { randomUUID } from "crypto";
import { HAILUO_BASE } from "./constants";
import type { HailuoContext } from "./context";
import { getCookies, getHailuoToken, log } from "./context";
import { prepareImage } from "./image";
import { buildQuery, hlHeaders, hlParams } from "./sign";

export type UploadResult = [string, string, string]; // fileId, cdnUrl, originalName

async function getSts(token: string, ctx: HailuoContext): Promise<Record<string, string>> {
  const params = hlParams();
  const q = buildQuery(params);
  const r = await fetch(`${HAILUO_BASE}/v1/api/files/request_policy?${q}`, {
    headers: hlHeaders(token, ctx.projectId, "", getCookies(ctx)),
  });
  if (!r.ok) throw new Error(`STS ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const resp = (await r.json()) as { data?: Record<string, string> };
  return resp.data || {};
}

async function uploadImpl(
  uploadPath: string,
  originalName: string,
  token: string,
  ctx: HailuoContext,
): Promise<UploadResult> {
  const fileUuid = randomUUID();
  const ext = "jpeg";
  const fileSize = fs.statSync(uploadPath).size;

  const sts = await getSts(token, ctx);
  const fileDir = (sts.dir || "").replace(/\/$/, "");
  const endpoint = sts.endpoint || "oss-us-east-1.aliyuncs.com";
  const bucketName = sts.bucketName || "hailuo-video";
  const fileName = `${fileUuid}.${ext}`;
  const ossPath = `${fileDir}/${fileName}`;

  log(`    OSS upload → ...${ossPath.slice(-40)}`);
  const client = new OSS({
    accessKeyId: sts.accessKeyId!,
    accessKeySecret: sts.accessKeySecret!,
    stsToken: sts.securityToken,
    bucket: bucketName,
    endpoint: endpoint.startsWith("http") ? endpoint : `https://${endpoint}`,
  });
  await client.put(ossPath, uploadPath);
  log("    OSS OK");

  let cdnUrl = `https://cdn.hailuoai.video/${ossPath}`;
  const params = hlParams();
  const body = {
    fileName,
    originFileName: originalName,
    dir: fileDir,
    endpoint,
    bucketName,
    size: String(fileSize),
    mimeType: ext,
    fileScene: 10,
  };
  const q = buildQuery(params);
  const r = await fetch(`${HAILUO_BASE}/v1/api/files/policy_callback?${q}`, {
    method: "POST",
    headers: hlHeaders(token, ctx.projectId, "", getCookies(ctx)),
    body: JSON.stringify(body),
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error("Hailuo token süresi dolmuş — token güncelle");
  }
  if (!r.ok) throw new Error(`policy_callback ${r.status}: ${(await r.text()).slice(0, 300)}`);

  const data = ((await r.json()) as { data?: Record<string, string> }).data || {};
  const fileId = data.fileID || data.file_id;
  if (!fileId) throw new Error(`fileID alınamadı`);
  const ossUrl = data.ossPath || data.oss_path || data.url;
  if (ossUrl) cdnUrl = ossUrl;
  log(`    fileID: ${fileId}`);
  return [fileId, cdnUrl, originalName];
}

export async function uploadImage(
  imgPath: string,
  token: string,
  ctx: HailuoContext,
  addNoise = false,
): Promise<UploadResult> {
  const { tmpPath, cleanup } = await prepareImage(imgPath, addNoise);
  try {
    return await uploadImpl(tmpPath, path.basename(imgPath), token, ctx);
  } finally {
    cleanup();
  }
}
