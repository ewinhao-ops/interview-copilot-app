// 整段录音一次转写(阿里百炼 DashScope Paraformer 实时 WS,用于上传后的整段识别)。
// 改造后不存音频:转写完成即丢弃音频二进制,只保留文本。
// 用 Node 22 内置全局 WebSocket,无需 ws 依赖。
import { randomUUID } from "node:crypto";
import { readAiConfig } from "../ai.js";

const DEFAULT_WS = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const TASK_TIMEOUT_MS = 60_000;

export interface TranscribeResult {
  text: string;
  ok: boolean;
  error?: string;
}

/** 把整段 PCM/音频缓冲发给 DashScope 实时识别,收齐结果后返回整段文本。 */
export async function transcribeAudio(opts: {
  audio: Buffer;
  format?: string; // pcm | wav | mp3 | opus ...
  sampleRate?: number;
}): Promise<TranscribeResult> {
  const cfg = readAiConfig();
  const apiKey = cfg.dashScopeApiKey;
  if (!apiKey) return { text: "", ok: false, error: "DashScope API key 未配置" };
  if (!opts.audio?.length) return { text: "", ok: false, error: "空音频" };

  const url = process.env.DASHSCOPE_WEBSOCKET_URL || DEFAULT_WS;
  const model = cfg.dashScopeAsrModel || "paraformer-realtime-v2";
  const format = opts.format || "pcm";
  const sampleRate = opts.sampleRate || 16000;
  const taskId = randomUUID();

  return new Promise<TranscribeResult>((resolve) => {
    let settled = false;
    const sentences: string[] = [];
    const done = (r: TranscribeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      resolve(r);
    };
    const timer = setTimeout(() => done({ text: sentences.join(""), ok: sentences.length > 0, error: "转写超时" }), TASK_TIMEOUT_MS);

    // 全局 WebSocket 支持 headers 选项(undici)
    const ws = new WebSocket(url, { headers: { Authorization: `bearer ${apiKey}`, "X-DashScope-DataInspection": "enable" } } as any);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio", task: "asr", function: "recognition", model,
          parameters: { format, sample_rate: sampleRate },
          input: {},
        },
      }));
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      // 二进制不会从服务端来;只处理文本事件
      if (typeof ev.data !== "string") return;
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const event = msg?.header?.event;
      if (event === "task-started") {
        // 整段音频分块发送(每块 ~3200B ≈ 100ms@16k16bit),最后 finish-task
        const chunkSize = 3200;
        for (let i = 0; i < opts.audio.length; i += chunkSize) {
          ws.send(opts.audio.subarray(i, i + chunkSize));
        }
        ws.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } }));
      } else if (event === "result-generated") {
        const text = msg?.payload?.output?.sentence?.text;
        const isEnd = msg?.payload?.output?.sentence?.sentence_end;
        if (typeof text === "string" && isEnd) sentences.push(text);
      } else if (event === "task-finished") {
        done({ text: sentences.join(""), ok: true });
      } else if (event === "task-failed") {
        done({ text: sentences.join(""), ok: false, error: msg?.header?.error_message || "task-failed" });
      }
    });

    ws.addEventListener("error", () => done({ text: sentences.join(""), ok: false, error: "WebSocket 连接错误" }));
    ws.addEventListener("close", () => { if (!settled) done({ text: sentences.join(""), ok: sentences.length > 0 }); });
  });
}
