import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";

export async function prepareImage(
  imgPath: string,
  addNoise: boolean,
): Promise<{ tmpPath: string; cleanup: () => void }> {
  let img = sharp(imgPath).rotate().toColorspace("srgb");
  const meta = await img.metadata();
  let w = meta.width || 0;
  let h = meta.height || 0;
  if (w > 1920) {
    const ratio = 1920 / w;
    w = 1920;
    h = Math.round(h * ratio);
    img = img.resize(w, h);
  }

  let pipeline = img;
  if (addNoise) {
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const pixels = new Uint8Array(data);
    const count = Math.max(50, Math.floor((info.width * info.height) / 200));
    for (let i = 0; i < count; i++) {
      const x = Math.floor(Math.random() * info.width);
      const y = Math.floor(Math.random() * info.height);
      const idx = (y * info.width + x) * info.channels;
      for (let c = 0; c < 3; c++) {
        pixels[idx + c] = Math.max(
          0,
          Math.min(255, pixels[idx + c] + Math.floor(Math.random() * 7) - 3),
        );
      }
    }
    pipeline = sharp(pixels, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    });
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `l2-hailuo-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
  );
  await pipeline.jpeg({ quality: addNoise ? 95 : 90 }).toFile(tmpPath);
  return {
    tmpPath,
    cleanup: () => {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* */
      }
    },
  };
}
