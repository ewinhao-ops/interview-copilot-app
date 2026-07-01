// 浏览器端采集 16kHz / 16bit / 单声道 PCM —— 正是 DashScope Paraformer 需要的格式。
// 不用 MediaRecorder(产出 webm 容器,服务端流式识别无法直接吃),改用 AudioContext 取原始采样。
const TARGET_RATE = 16000;

export interface PcmRecorder {
  stop: () => Promise<{ pcm: Int16Array; sampleRate: number; durationMs: number }>;
  cancel: () => void;
  /** 实时波形分析器(画波形用) */
  analyser: AnalyserNode;
}

/** 只监听麦克风出波形、不录制 —— 设备检测用(看到波形=麦克风正常,无需转写) */
export interface MicMonitor {
  analyser: AnalyserNode;
  level: () => number;
  stop: () => void;
}

function makeAnalyser(ctx: AudioContext, source: MediaStreamAudioSourceNode): AnalyserNode {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);
  return analyser;
}

/** 取当前瞬时音量(RMS,0~1) */
export function readLevel(analyser: AnalyserNode): number {
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
  return Math.min(1, Math.sqrt(sum / buf.length) * 2.2);
}

export async function startMicMonitor(): Promise<MicMonitor> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx: AudioContext = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = makeAnalyser(ctx, source);
  return {
    analyser,
    level: () => readLevel(analyser),
    stop: () => {
      try { source.disconnect(); analyser.disconnect(); } catch { /* noop */ }
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => undefined);
    },
  };
}

export async function startPcmRecorder(): Promise<PcmRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx: AudioContext = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = makeAnalyser(ctx, source);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  const startedAt = Date.now();

  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  // ScriptProcessor 需连到 destination 才会触发 onaudioprocess;但直连扬声器会在手机没戴耳机时
  // 把麦克风原声外放成回声。经一个 gain=0 的静音节点输出,既驱动回调又不外放。
  const mute = ctx.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(ctx.destination);

  const teardown = () => {
    try { processor.disconnect(); mute.disconnect(); source.disconnect(); analyser.disconnect(); } catch { /* noop */ }
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => undefined);
  };

  return {
    analyser,
    cancel: teardown,
    stop: async () => {
      const inputRate = ctx.sampleRate;
      teardown();
      // 合并 + 降采样到 16k + 转 Int16
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Float32Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      const pcm = downsampleToInt16(merged, inputRate, TARGET_RATE);
      return { pcm, sampleRate: TARGET_RATE, durationMs: Date.now() - startedAt };
    },
  };
}

function downsampleToInt16(input: Float32Array, inRate: number, outRate: number): Int16Array {
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  }
  return btoa(binary);
}
