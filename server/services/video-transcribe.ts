// 主播岗每题视频回答 -> 转文字:从 COS 拉视频 -> ffmpeg 抽 16k 单声道 PCM -> DashScope ASR。
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import https from "node:https";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cosPresignUrl } from "./cos.js";
import { transcribeAudio } from "./transcribe.js";

function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ((res.statusCode || 500) >= 300) { res.resume(); return reject(new Error("cos_get_" + res.statusCode)); }
      const ch: Buffer[] = [];
      res.on("data", (d) => ch.push(d));
      res.on("end", () => resolve(Buffer.concat(ch)));
    }).on("error", reject);
  });
}

/** 用 ffmpeg 把视频转成 16k 单声道 PCM(s16le)。视频写临时文件再读(兼容 mp4 的 moov 位置)。 */
async function extractPcm(video: Buffer, ext: string): Promise<Buffer> {
  const tmp = join(tmpdir(), `cv-${randomUUID()}.${ext}`);
  await writeFile(tmp, video);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const ff = spawn("ffmpeg", ["-i", tmp, "-vn", "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
      const out: Buffer[] = [];
      ff.stdout.on("data", (d) => out.push(d));
      ff.on("error", reject);
      ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error("ffmpeg_exit_" + code))));
    });
  } finally {
    unlink(tmp).catch(() => undefined);
  }
}

/** 拉 COS 上的视频对象,抽音频转写成文字。失败返回空串(调用方可重试/手动)。 */
export async function transcribeCosVideo(key: string): Promise<string> {
  const ext = (key.split(".").pop() || "webm").toLowerCase();
  const video = await fetchBuffer(cosPresignUrl("GET", key, 600));
  const pcm = await extractPcm(video, ext);
  if (!pcm.length) return "";
  const r = await transcribeAudio({ audio: pcm, format: "pcm", sampleRate: 16000 });
  return r.ok ? r.text : "";
}
