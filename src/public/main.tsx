// 候选人异步面试公开页(独立 bundle,不含任何后台代码/接口)。
// 流程:品牌入口/设备检测(波形,无需转写) -> 拍照 -> 逐题(读题 -> 录音作答带波形 -> 可重答/传图 -> 手动下一题) -> 结束提交。
// 转写与 AI 评判在后台异步进行,候选人提交即走,不等待。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { startPcmRecorder, startMicMonitor, int16ToBase64, type PcmRecorder, type MicMonitor } from "./pcm-recorder.js";
import "./styles.css";

const READ_SECONDS = 30;
const ANSWER_MAX_SECONDS = 240;
// 即便设为"不限时",单题录音也有一个很宽松的安全上限(防止忘记结束导致录音无限增长、
// 上传包过大拖慢服务器)。正常作答远到不了。
const ANSWER_HARD_CAP_SECONDS = 30 * 60;

function getToken(): string {
  const path = location.pathname.replace(/\/+$/, "");
  const m = path.match(/\/interview\/([^/]+)$/) || location.hash.match(/interview\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : "";
}
function getBookingToken(): string {
  const path = location.pathname.replace(/\/+$/, "");
  const m = path.match(/\/booking\/([^/]+)$/) || location.hash.match(/booking\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : "";
}
function getCollectToken(): string {
  const path = location.pathname.replace(/\/+$/, "");
  const m = path.match(/\/collect\/([^/]+)$/) || location.hash.match(/collect\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : "";
}
function getShareToken(): string {
  const path = location.pathname.replace(/\/+$/, "");
  const m = path.match(/\/share\/([^/]+)$/) || location.hash.match(/share\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : "";
}

const api = {
  async get(token: string) {
    const r = await fetch(`/api/public/interview/${token}`);
    return r.json();
  },
  async post(path: string, body?: unknown) {
    // 始终带空 JSON body:Cloudflare 隧道下"有 application/json 头但空 body"的 POST 会被 Fastify 拒成 415
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    return r.json();
  },
  async del(path: string) {
    const r = await fetch(path, { method: "DELETE" });
    return r.json();
  },
  // 上传一个作品(图片/视频):二进制 + XHR,带上传进度
  uploadWork(token: string, file: File, mime: string, onProgress: (p: number) => void): Promise<any> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/public/interview/${token}/works`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("x-file-mime", mime);
      xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name || ""));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText || "{}")); } catch { reject(new Error("解析失败")); } };
      xhr.onerror = () => reject(new Error("网络错误"));
      xhr.send(file);
    });
  },
};

interface Question { questionId: string; ord: number; originalQuestion: string; status: string; followUpQuestion?: string; audioReceived?: number; answerCompletedAt?: string; }
interface WorkItem { id: string; name?: string; mime?: string; size?: number; type: "image" | "video" | "file"; url: string; }
interface Interview { id: string; candidateName?: string; candidateRole?: string; brandName?: string; status: string; gate?: "ok" | "completed" | "locked"; currentQuestionId?: string; inviteExpiresAt?: string; answerLimitSec?: number; maxDurationMin?: number; inviteTtlHours?: number; deadlineAt?: string | null; reminders?: Array<{ date: string; startTime?: string | null; endTime?: string | null; title: string }>; worksUpload?: boolean; worksMax?: number; decision?: { result: "pass" | "reject" | null; note: string; at?: string } | null; submittedAt?: string; questions: Question[]; }

function fmt(sec: number) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function fmtSize(bytes?: number) {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + "MB";
  return Math.max(1, Math.round(bytes / 1024)) + "KB";
}

/** 把图片文件压到最长边 1280、jpeg,返回 dataURL */
function resizeImage(file: File, max = 1280, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d")!.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
    img.src = url;
  });
}

/** gzip 压缩(浏览器支持时);不支持则返回 null,改发原始二进制 */
async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    if (typeof (window as any).CompressionStream === "undefined") return null;
    const cs = new (window as any).CompressionStream("gzip");
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(cs);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  } catch { return null; }
}

/** 上传整段 PCM:二进制 + gzip(去掉 base64,体积砍半、编码更快) */
// 上传整段录音;失败自动重试(网络抖动很常见),返回是否最终成功 —— 一次性面试不能静默丢答案
async function uploadAudio(token: string, qid: string, pcm: Int16Array, sampleRate: number): Promise<boolean> {
  const raw = new Uint8Array(pcm.buffer);
  const gz = await gzipBytes(raw);
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream", "x-sample-rate": String(sampleRate) };
  if (gz) headers["x-audio-encoding"] = "gzip";
  const body = (gz ?? raw) as BodyInit;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`/api/public/interview/${token}/questions/${qid}/answer`, { method: "POST", headers, body });
      if (res.ok) return true;
      if (res.status === 409 || res.status === 410) return false; // 会话已结束/过期,重试无意义
    } catch { /* 网络错误,重试 */ }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  return false;
}

function App() {
  const token = getToken();
  const [stage, setStage] = useState<"loading" | "error" | "locked" | "intro" | "device" | "photo" | "interview" | "works" | "finished">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [interview, setInterview] = useState<Interview | null>(null);

  const [refreshing, setRefreshing] = useState(false);

  // 根据后端最新状态决定显示哪个界面。结论(通过/不通过)优先级最高:
  // 无论这场面试是正常完成、超时还是被终止,只要面试官下了结论,候选人打开就能看到通知。
  const applyState = useCallback((itv: Interview) => {
    setInterview(itv);
    const dec = itv.decision;
    const gate = itv.gate;
    const qs: Question[] = itv.questions || [];
    const allAnswered = qs.length > 0 && qs.every((q) => q.status === "answered");
    if (dec?.result === "pass" || dec?.result === "reject") setStage("finished"); // 已有结论 -> 通知页
    else if (gate === "completed") setStage("finished"); // 已提交,等待结果
    else if (gate === "locked") setStage("locked");
    else if (itv.status === "in_progress") {
      if (itv.worksUpload && allAnswered) setStage("works");
      else setStage("interview"); // 跳过设备检测/拍照
    } else setStage("intro"); // 全新未开始 -> 先看面试须知,确认后再设备检测
  }, []);

  useEffect(() => {
    if (!token) { setStage("error"); setErrorMsg("链接无效"); return; }
    api.get(token).then((res) => {
      if (!res.ok) {
        setStage("error");
        setErrorMsg(res.error === "link_expired" ? "邀约链接已过期。请联系面试官重新发送。" : "链接无效或不存在。");
        return;
      }
      applyState(res.interview);
    }).catch(() => { setStage("error"); setErrorMsg("网络错误,请稍后重试。"); });
  }, [token, applyState]);

  // 候选人在等待页主动/自动刷新结果
  const refresh = useCallback(async () => {
    if (!token) return;
    setRefreshing(true);
    try { const res = await api.get(token); if (res.ok) applyState(res.interview); } catch { /* 忽略 */ }
    setRefreshing(false);
  }, [token, applyState]);

  // 等待结果时,每 60s 自动拉一次;页面切到后台(document.hidden)时暂停,避免长期空轮询;有结论即停。
  useEffect(() => {
    if (stage !== "finished" || interview?.decision?.result) return;
    const t = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
    return () => clearInterval(t);
  }, [stage, interview?.decision?.result, refresh]);

  // 上报当前步骤,供后台实时查看候选人进度(设备检测/拍照/作品上传;答题阶段由 InterviewFlow 上报)
  useEffect(() => {
    if (!token) return;
    if (stage === "device" || stage === "photo" || stage === "works") {
      api.post(`/api/public/interview/${token}/presence`, { stage }).catch(() => undefined);
    }
  }, [stage, token]);

  // 收尾:标记完成 + 触发后台评估,候选人进完成页。幂等:重复触发只切到完成页,不再重打 /finish
  const finishedRef = useRef(false);
  const finishNow = useCallback(async () => {
    if (finishedRef.current) { setStage("finished"); return; }
    finishedRef.current = true;
    try { await api.post(`/api/public/interview/${token}/finish`); } catch { /* 后台可重生成报告 */ }
    setStage("finished");
  }, [token]);
  // 仅触发后台收尾(/finish),不切页面。供末题"乐观提交"在末段录音上传完成后调用,
  // 确保 /finish 晚于末段 /answer+/complete,避免会话先 completed 把末段挡成 409 丢失。
  const markFinished = useCallback(async () => {
    finishedRef.current = true;
    try { await api.post(`/api/public/interview/${token}/finish`); } catch { /* 后台可重生成报告 */ }
  }, [token]);

  const brand = interview?.brandName || "AI 面试";
  const role = interview?.candidateRole;
  const name = interview?.candidateName;

  if (stage === "loading") return <Shell brand={brand}><p className="muted center-text">加载中…</p></Shell>;
  if (stage === "error") return <Shell brand={brand}><div className="panel danger"><h2>无法开始面试</h2><p className="muted">{errorMsg}</p></div></Shell>;
  if (stage === "locked") return (
    <Shell brand={brand}>
      <div className="panel danger center-text">
        <h2>本轮面试已结束</h2>
        <p className="muted">此面试链接<b>仅可使用一次</b>,需在开始后的规定时间内<b>一次性连续完成</b>。本次因<b>已完成、超时或中途离开</b>而结束,无法再次进入或修改作答。</p>
        <p className="muted">如确需重做,请联系面试官在后台为你<b>重新开启</b>。</p>
      </div>
    </Shell>
  );
  if (stage === "finished") {
    const dec = interview?.decision;
    const decidedAt = dec?.at ? dec.at.slice(0, 10) : "";
    const submitted = interview?.submittedAt ? interview.submittedAt.slice(5, 16).replace("T", " ") : "";
    if (dec?.result === "pass") return (
      <Shell brand={brand} role={role} name={name}>
        <div className="panel success center-text">
          <ReminderBanner reminders={interview?.reminders} />
          <div className="big-check"><i /></div>
          <h2>恭喜!你已通过本轮面试 🎉</h2>
          <div className="result-note pass">{dec.note || "恭喜通过本轮面试,我们将尽快与你联系,安排后续流程。"}</div>
          <p className="muted">我们会尽快通过<b>电话 / 微信</b>与你联系,安排后续(复试 / 入职沟通)。请保持电话畅通。</p>
          {decidedAt && <p className="muted small">通知时间:{decidedAt}</p>}
        </div>
      </Shell>
    );
    if (dec?.result === "reject") return (
      <Shell brand={brand} role={role} name={name}>
        <div className="panel center-text">
          <h2>面试结果通知</h2>
          <p className="muted">感谢{name ? ` ${name} ` : "你"}参加本次面试。经综合评估,本次暂未推进。</p>
          {dec.note && <div className="result-note">{dec.note}</div>}
          <p className="muted small">感谢你投入的时间,也欢迎未来有合适机会再次合作,祝一切顺利。</p>
          {decidedAt && <p className="muted small">通知时间:{decidedAt}</p>}
        </div>
      </Shell>
    );
    // 已提交,等待结果
    return (
      <Shell brand={brand} role={role} name={name}>
        <div className="panel success center-text">
          <ReminderBanner reminders={interview?.reminders} />
          <div className="big-check"><i /></div>
          <h2>面试已提交,感谢参与 ✅</h2>
          <p className="muted">你的面试回答已成功提交{submitted ? `(${submitted})` : ""},我们已收到。</p>
          <div className="wait-box">
            <p>我们会在 <b>3–5 个工作日内</b> 完成评估,并在<b>本页面</b>公布结果。</p>
            <p className="muted small"><b>请务必收藏好这条面试链接</b>,并<b>随时回来打开 / 刷新本页</b>关注面试结果通知;结果出来后会在此页面显示,也会发短信到你填写的手机号。若通过,我们还会通过电话 / 微信与你联系,请保持畅通。</p>
          </div>
          <button className="btn primary lg" onClick={refresh} disabled={refreshing}>{refreshing ? "刷新中…" : "🔄 刷新查看结果"}</button>
          <p className="muted small" style={{ marginTop: 10 }}>本页约每分钟也会自动刷新一次,有结果会自动显示。</p>
        </div>
      </Shell>
    );
  }
  if (stage === "intro") return <IntroNotice brand={brand} role={role} name={name} interview={interview!} onConfirm={() => setStage("device")} />;
  if (stage === "device") return <DeviceCheck brand={brand} role={role} name={name} token={token} onPass={() => setStage("photo")} />;
  if (stage === "photo") return <PhotoCapture brand={brand} role={role} name={name} token={token} onDone={() => setStage("interview")} />;
  if (stage === "works") return <WorksUpload brand={brand} role={role} name={name} token={token} max={interview?.worksMax ?? 5} onSubmit={finishNow} />;
  return (
    <InterviewFlow
      token={token}
      interview={interview!}
      // 答完最后一题:乐观切页(视频岗去作品上传,其余进完成页),此处不触发 /finish
      onAllAnswered={() => { if (interview?.worksUpload) setStage("works"); else setStage("finished"); }}
      // 末段录音上传完成后再触发后台收尾(/finish);非视频岗用,避免会话先 completed 丢末段
      onFinalize={markFinished}
      // 中途「结束面试」:直接收尾(不进作品步骤)
      onAbort={finishNow}
    />
  );
}

/** 整页外壳:品牌头 + 居中内容 */
function Shell({ brand, role, name, children, wide }: { brand: string; role?: string; name?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="page">
      <header className="brand-bar">
        <div className="brand-logo">{brand}</div>
        <div className="brand-tag">AI 智能面试</div>
      </header>
      {(role || name) && (
        <div className="who">
          {role && <span className="who-role">{role}</span>}
          {name && <span className="who-name">{name}</span>}
        </div>
      )}
      <main className={"page-body" + (wide ? " wide" : "")}>{children}</main>
      <footer className="page-foot muted">本次面试由 {brand} 提供 · 请保持网络畅通</footer>
    </div>
  );
}

/** 实时波形(柱状音频条,读取 analyser 频谱数据) */
function Waveform({ analyser, active }: { analyser: AnalyserNode | null; active: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!analyser || !active) return;
    const canvas = ref.current; if (!canvas) return;
    const g = canvas.getContext("2d"); if (!g) return;
    const buf = new Uint8Array(analyser.fftSize); // 时域采样,按振幅画柱(铺满整宽)
    const BARS = 40;
    const per = Math.floor(buf.length / BARS);
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = canvas.width, h = canvas.height;
      analyser.getByteTimeDomainData(buf);
      g.clearRect(0, 0, w, h);
      const gap = 4;
      const bw = (w - gap * (BARS - 1)) / BARS;
      for (let i = 0; i < BARS; i++) {
        // 该柱对应时间片段的峰值振幅
        let peak = 0;
        const start = i * per;
        for (let j = 0; j < per; j++) { const v = Math.abs(buf[start + j] - 128) / 128; if (v > peak) peak = v; }
        const amp = Math.min(1, peak * 1.8);
        const bh = Math.max(4, amp * h * 0.92);
        const x = i * (bw + gap);
        const y = (h - bh) / 2; // 上下居中
        g.fillStyle = amp > 0.04 ? "#d4af37" : "#3a3520";
        const r = Math.min(bw / 2, 3);
        g.beginPath();
        g.moveTo(x + r, y); g.arcTo(x + bw, y, x + bw, y + bh, r); g.arcTo(x + bw, y + bh, x, y + bh, r);
        g.arcTo(x, y + bh, x, y, r); g.arcTo(x, y, x + bw, y, r); g.closePath(); g.fill();
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser, active]);
  return <canvas ref={ref} className="waveform" width={640} height={96} />;
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="screen center">{children}</div>;
}

// ───────── 面试官在日历里给本人安排的提醒(候选人页顶部展示) ─────────
function ReminderBanner({ reminders }: { reminders?: Array<{ date: string; startTime?: string | null; endTime?: string | null; title: string }> }) {
  if (!reminders || !reminders.length) return null;
  const fmt = (r: { date: string; startTime?: string | null; endTime?: string | null }) => {
    const d = new Date(r.date + "T00:00:00");
    const wd = "日一二三四五六"[d.getDay()] || "";
    const t = r.startTime ? ` ${r.startTime}${r.endTime ? "-" + r.endTime : ""}` : "";
    return `${d.getMonth() + 1}月${d.getDate()}日 周${wd}${t}`;
  };
  return (
    <div className="reminder-banner">
      <div className="rb-title">📅 面试官给你的安排</div>
      {reminders.map((r, i) => <div key={i} className="rb-item"><b>{fmt(r)}</b> · {r.title}</div>)}
    </div>
  );
}

// ───────── 面试须知:开始前的确认页(有效期/单次性/完成通知/认真对待),确认后才进设备检测 ─────────
function IntroNotice({ brand, role, name, interview, onConfirm }: { brand: string; role?: string; name?: string; interview: Interview; onConfirm: () => void }) {
  const maxMin = interview.maxDurationMin || 0;          // 整场总时长(分钟,0=不限)
  const perMin = interview.answerLimitSec ? Math.round(interview.answerLimitSec / 60) : 0; // 每题约 X 分钟
  const exp = interview.inviteExpiresAt ? new Date(interview.inviteExpiresAt) : null;
  const fmt = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return (
    <Shell brand={brand} role={role} name={name}>
      <div className="panel">
        <h2>面试须知 · 请先阅读</h2>
        <p className="muted" style={{ marginTop: 0 }}>{name ? `${name},` : ""}欢迎参加{role ? ` ${role} 岗位` : ""}的面试。正式开始前,请务必阅读并确认以下事项:</p>
        <ReminderBanner reminders={interview.reminders} />
        <ol className="notice-list">
          <li>
            <b>⏱ 链接有效期与时长</b><br />
            本邀约链接{exp ? <>需在 <b>{fmt(exp)}</b> 前打开并开始</> : <>有效期 {interview.inviteTtlHours || 48} 小时</>}。
            {maxMin > 0
              ? <> 一旦开始答题,须在 <b>{maxMin} 分钟</b>内一次性连续完成全部题目,超时本轮自动结束。</>
              : <> 请预留充足时间一次性完成。</>}
            {perMin > 0 ? <>(每题作答约 {perMin} 分钟)</> : null}
          </li>
          <li>
            <b>🔒 仅可进行一次</b><br />
            链接<b>只能进入一次</b>。中途退出、刷新离开或超时,本轮即结束、<b>无法重新进入</b>。
            所以<b>开始之前请务必做好准备</b>:安静不被打扰的环境、可用的麦克风/摄像头、稳定的网络、充足的时间。
          </li>
          <li>
            <b>📨 完成即时通知</b><br />
            你提交完成后,系统会<b>第一时间通知面试官</b>,请耐心等待结果。
          </li>
          <li>
            <b>✅ 认真对待</b><br />
            面试前请<b>提前准备好</b>;面试过程中请<b>认真对待每一道题目</b>,从容表达、展现真实水平。
          </li>
        </ol>
        <button className="btn primary lg wide" onClick={onConfirm}>我已了解,准备好了,开始面试 →</button>
      </div>
    </Shell>
  );
}

// ───────── 设备检测:波形确认麦克风 + 收集本人手机号 ─────────
function DeviceCheck({ brand, role, name, token, onPass }: { brand: string; role?: string; name?: string; token: string; onPass: () => void }) {
  const [mon, setMon] = useState<MicMonitor | null>(null);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState("");
  const [starting, setStarting] = useState(false);
  const [phone, setPhone] = useState("");
  const [savingPhone, setSavingPhone] = useState(false);

  const phoneValid = /^1[3-9]\d{9}$/.test(phone);

  const start = async () => {
    setErr(""); setStarting(true);
    try { const m = await startMicMonitor(); setMon(m); }
    catch { setErr("无法访问麦克风,请在浏览器允许麦克风权限后重试。"); }
    setStarting(false);
  };
  useEffect(() => {
    if (!mon) return;
    const t = setInterval(() => { if (mon.level() > 0.12) setOk(true); }, 150);
    return () => clearInterval(t);
  }, [mon]);
  useEffect(() => () => mon?.stop(), [mon]);

  const proceed = async () => {
    if (!phoneValid) { setErr("请填写本人 11 位手机号,否则将收不到面试结果短信。"); return; }
    setErr(""); setSavingPhone(true);
    try { await api.post(`/api/public/interview/${token}/phone`, { phone }); }
    catch { /* 保存失败不阻断面试,后续仍可在简历兜底 */ }
    setSavingPhone(false);
    mon?.stop(); onPass();
  };

  return (
    <Shell brand={brand} role={role} name={name}>
      <div className="panel">
        <h2>开始前,先测一下麦克风</h2>
        <div className="oneshot-note">⚠ 本面试链接<b>仅可使用一次</b>。请在安静、不被打扰的环境下<b>一次性连续完成所有题目</b>。<br />短暂刷新或断网,<b>10 分钟内可恢复继续</b>;但长时间离开或超时,本轮将结束、无法再次进入。</div>
        <p className="muted">{name ? `${name},` : ""}点下方按钮,对着麦克风说一句话(例如「你好,我准备好了」)。<b>只要看到下面的波形在跳动</b>,就说明麦克风正常,可以开始面试。</p>
        {!mon ? (
          <div className="center-text" style={{ margin: "22px 0 6px" }}>
            <button className="btn primary lg" onClick={start} disabled={starting}>{starting ? "开启中…" : "开启麦克风测试"}</button>
          </div>
        ) : (
          <div className="wave-wrap">
            <Waveform analyser={mon.analyser} active />
            <div className={"wave-hint " + (ok ? "ok" : "")}>{ok ? "✓ 麦克风工作正常" : "请说一句话,让波形动起来…"}</div>
          </div>
        )}

        <div className="phone-field" style={{ marginTop: 18 }}>
          <label className="phone-label" style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>填写本人手机号(接收面试结果通知)</label>
          <input
            className="phone-input"
            type="tel"
            inputMode="numeric"
            maxLength={11}
            placeholder="请输入 11 位手机号"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
            style={{ width: "100%", padding: "12px 14px", fontSize: 16, borderRadius: 8, border: "1px solid var(--line, #d0d5dd)", boxSizing: "border-box" }}
          />
          <p className="muted small" style={{ marginTop: 6 }}>⚠ 面试结果将以<b>短信</b>发送到此号码。<b>请务必填写本人正确手机号</b>,填错将收不到通知。<br />如果没收到短信,<b>重新打开本面试链接即可看到结果通知</b>。</p>
        </div>

        {err && <p className="warn">{err}</p>}
        <button className="btn primary lg wide" disabled={!ok || !phoneValid || savingPhone} onClick={proceed}>
          {savingPhone ? "保存中…" : !ok ? "先完成麦克风测试" : !phoneValid ? "请填写本人手机号" : "麦克风正常,开始面试 →"}
        </button>
      </div>
    </Shell>
  );
}

// ───────── 拍照存档(保留) ─────────
function PhotoCapture({ brand, role, name, token, onDone }: { brand: string; role?: string; name?: string; token: string; onDone: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const startCam = useCallback(async () => {
    setErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => undefined); }
    } catch { setErr("无法访问摄像头,请在浏览器允许摄像头权限。"); }
  }, []);
  useEffect(() => { startCam(); return () => streamRef.current?.getTracks().forEach((t) => t.stop()); }, [startCam]);

  const capture = () => {
    const v = videoRef.current; if (!v) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth || 640; c.height = v.videoHeight || 480;
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    setShot(c.toDataURL("image/jpeg", 0.8));
  };
  const submit = async () => {
    if (!shot) return;
    setBusy(true);
    try {
      await api.post(`/api/public/interview/${token}/photo`, { photoBase64: shot });
      streamRef.current?.getTracks().forEach((t) => t.stop());
      onDone();
    } catch { setErr("上传失败,请重试。"); setBusy(false); }
  };

  return (
    <Shell brand={brand} role={role} name={name}>
      <div className="panel center-text">
        <h2>拍一张本人照片</h2>
        <p className="muted">用于确认面试者身份。请正对摄像头、光线充足,然后拍照。</p>
        <div className="cam-box">
          {!shot ? <video ref={videoRef} playsInline muted className="cam" /> : <img src={shot} className="cam" alt="预览" />}
        </div>
        {err && <p className="warn">{err}</p>}
        <div className="row center">
          {!shot
            ? <button className="btn primary lg" onClick={capture}>拍照</button>
            : <>
                <button className="btn ghost" onClick={() => setShot(null)}>重拍</button>
                <button className="btn primary lg" onClick={submit} disabled={busy}>{busy ? "上传中…" : "用这张,开始面试 →"}</button>
              </>}
        </div>
      </div>
    </Shell>
  );
}

// ───────── 作品集上传(仅 AI 视频岗位,答题后,选填) ─────────
function WorkCard({ w, onDelete, disabled }: { w: WorkItem; onDelete: () => void; disabled: boolean }) {
  return (
    <div className="work-card">
      {w.type === "video"
        ? <video className="work-media" src={w.url} controls preload="metadata" />
        : <img className="work-media" src={w.url} alt={w.name || "作品"} />}
      <div className="work-meta">
        <span className="work-name" title={w.name}>{w.type === "video" ? "🎬 " : "🖼 "}{w.name || (w.type === "video" ? "视频作品" : "图片作品")}</span>
        {w.size ? <span className="work-size">{fmtSize(w.size)}</span> : null}
      </div>
      <button className="work-del" onClick={onDelete} disabled={disabled}>删除</button>
    </div>
  );
}

function WorksUpload({ brand, role, name, token, max, onSubmit }: { brand: string; role?: string; name?: string; token: string; max: number; onSubmit: () => void | Promise<void>; }) {
  const [works, setWorks] = useState<WorkItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const imgInput = useRef<HTMLInputElement | null>(null);
  const vidInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch(`/api/public/interview/${token}/works`).then((r) => r.json()).then((res) => { if (res.ok) setWorks(res.works || []); }).catch(() => undefined);
  }, [token]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>, kind: "image" | "video") => {
    const file = (e.target.files || [])[0]; e.target.value = "";
    if (!file) return;
    if (works.length >= max) { setErr(`最多上传 ${max} 个作品。`); return; }
    const mime = file.type || (kind === "video" ? "video/mp4" : "image/jpeg");
    const cap = kind === "video" ? 100 * 1024 * 1024 : 15 * 1024 * 1024;
    if (file.size > cap) { setErr(kind === "video" ? "单个视频不能超过 100MB,请压缩或截取最精彩的片段后再上传。" : "单张图片不能超过 15MB。"); return; }
    setErr(""); setBusy(true); setProgress(0);
    try {
      const res = await api.uploadWork(token, file, mime, setProgress);
      if (res.ok && res.attachment) setWorks((xs) => [...xs, res.attachment]);
      else setErr(res.error === "too_large" ? "文件过大被拒绝。" : res.error === "max_reached" ? `最多 ${max} 个作品。` : res.error === "unsupported_type" ? "只支持图片或视频。" : "上传失败,请重试。");
    } catch { setErr("上传失败,请检查网络后重试。"); }
    setBusy(false); setProgress(0);
  };

  const del = async (id: string) => {
    if (busy || submitting) return;
    try { const res = await api.del(`/api/public/interview/${token}/works/${id}`); if (res.ok) setWorks((xs) => xs.filter((w) => w.id !== id)); } catch { /* ignore */ }
  };

  const submit = async () => { if (submitting || busy) return; setSubmitting(true); await onSubmit(); };
  const full = works.length >= max;
  const locked = busy || submitting;

  return (
    <Shell brand={brand} role={role} name={name} wide>
      <div className="panel">
        <h2>上传你的代表作品</h2>
        <p className="muted">最后一步(选填)。请挑选你<b>最能代表自己水平</b>的作品上传,图片或视频均可,最多 {max} 个。建议<b>优中选优</b>——只放最能打动面试官的代表作,比堆数量更有说服力。</p>
        <div className="works-count">已上传 <b>{works.length}</b> / {max}</div>
        {works.length > 0 && <div className="works-grid">{works.map((w) => <WorkCard key={w.id} w={w} onDelete={() => del(w.id)} disabled={locked} />)}</div>}
        {busy && (
          <div className="works-uploading">
            <div className="works-progress"><div className="works-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <span className="muted small">上传中… {Math.round(progress * 100)}%(视频较大时请耐心等待)</span>
          </div>
        )}
        {err && <p className="warn">{err}</p>}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn ghost" disabled={full || locked} onClick={() => imgInput.current?.click()}>+ 图片作品</button>
          <button className="btn ghost" disabled={full || locked} onClick={() => vidInput.current?.click()}>+ 视频作品</button>
        </div>
        {full && <p className="muted small">已达上限;如需替换,先删除其中一个再上传。</p>}
        <input ref={imgInput} type="file" accept="image/*" hidden onChange={(e) => onPick(e, "image")} />
        <input ref={vidInput} type="file" accept="video/*" hidden onChange={(e) => onPick(e, "video")} />
        <button className="btn primary lg wide" disabled={locked} onClick={submit}>
          {submitting ? "提交中…" : works.length > 0 ? "提交作品,完成面试 →" : "暂不上传,直接提交 →"}
        </button>
        <p className="muted small center-text" style={{ marginTop: 8 }}>作品为选填;提交后本次面试即结束。</p>
      </div>
    </Shell>
  );
}

// ───────── 逐题作答 ─────────
type QStage = "reading" | "answering";

function InterviewFlow({ token, interview, onAllAnswered, onFinalize, onAbort }: { token: string; interview: Interview; onAllAnswered: () => void; onFinalize: () => void | Promise<void>; onAbort: () => void }) {
  const brand = interview.brandName || "AI 面试";
  const role = interview.candidateRole;
  const name = interview.candidateName;
  const ordered = [...interview.questions].sort((a, b) => a.ord - b.ord);
  const total = ordered.length;
  const answerLimit = interview.answerLimitSec ?? ANSWER_MAX_SECONDS; // 0 = 不限时
  const unlimited = answerLimit <= 0;
  const deadlineMs = interview.deadlineAt ? new Date(interview.deadlineAt).getTime() : 0; // 整场总时长截止时刻(0=不限)

  const [idx, setIdx] = useState(() => { const i = ordered.findIndex((q) => q.status !== "answered"); return i < 0 ? 0 : i; });
  const current = ordered[idx];
  const isLast = idx >= total - 1;

  const [qStage, setQStage] = useState<QStage>("reading");
  const [readLeft, setReadLeft] = useState(READ_SECONDS);
  const [elapsed, setElapsed] = useState(0);
  const [totalLeft, setTotalLeft] = useState(() => deadlineMs ? Math.max(0, Math.round((deadlineMs - Date.now()) / 1000)) : 0);
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const recRef = useRef<PcmRecorder | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const beginAnswer = useCallback(async () => {
    setErr(""); setElapsed(0);
    // 托底①:开新录音前,先把任何遗留的录音器关掉,避免"重复开启"导致旧麦克风流泄漏一直占用麦克风。
    if (recRef.current) { try { recRef.current.cancel(); } catch { /* noop */ } recRef.current = null; }
    try {
      await api.post(`/api/public/interview/${token}/questions/${current.questionId}/start`);
      const rec = await startPcmRecorder();
      recRef.current = rec; setAnalyser(rec.analyser); setQStage("answering");
    } catch { setErr("无法开启麦克风。请在浏览器允许麦克风权限后,点下方「开始回答」重试。"); setQStage("reading"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.questionId, token]);

  // 结束本题:点一下立刻进下一题、计时器立即停;录音上传放后台静默进行
  const finishAndAdvance = useCallback(() => {
    const rec = recRef.current;
    if (!rec || busy === "submit") return;
    recRef.current = null;
    const qid = current.questionId;
    setAnalyser(null);
    if (isLast) {
      // 末题:乐观提交 —— 立即进完成/作品页,不让候选人卡在"提交中"。
      // 末段录音 stop+上传+complete 全部后台跑;关键:必须等末段上传+complete 后才触发 /finish(onFinalize),
      // 否则会话先被置 completed,末段 /answer 会被 409 挡掉、末题答案丢失。视频岗的 /finish 由作品页提交时触发。
      onAllAnswered();
      (async () => {
        try {
          const { pcm, sampleRate } = await rec.stop();
          await uploadAudio(token, qid, pcm, sampleRate);
          await api.post(`/api/public/interview/${token}/questions/${qid}/complete`);
        } catch { /* 末段后台上传失败:uploadAudio 已重试 3 次,服务端对在途末段也放行;其余题已提交,后台仍可生成报告 */ }
        if (!interview.worksUpload) { try { await onFinalize(); } catch { /* 后台可重生成报告 */ } }
      })();
    } else {
      // 非末题:UI 立即推进(计时器随 qStage 切换而停),上传在后台跑
      setIdx((i) => i + 1); setImages([]); setQStage("reading");
      (async () => {
        try {
          const { pcm, sampleRate } = await rec.stop();
          await uploadAudio(token, qid, pcm, sampleRate);
          await api.post(`/api/public/interview/${token}/questions/${qid}/complete`);
        } catch { /* 忽略 */ }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.questionId, token, isLast, onAllAnswered, onFinalize, busy]);

  // 重新录制本题(答错了重来)
  const reRecord = useCallback(() => {
    if (busy) return;
    if (recRef.current) { try { recRef.current.cancel(); } catch { /* noop */ } recRef.current = null; setAnalyser(null); }
    beginAnswer();
  }, [beginAnswer, busy]);

  // 结束整场面试:上传当前题录音(若在录)+ 收尾。供「手动结束」与「总时长到点」共用。
  const finishWholeInterview = useCallback(() => {
    const rec = recRef.current; recRef.current = null; setAnalyser(null);
    (async () => {
      try {
        if (rec) {
          const { pcm, sampleRate } = await rec.stop();
          await uploadAudio(token, current.questionId, pcm, sampleRate);
          await api.post(`/api/public/interview/${token}/questions/${current.questionId}/complete`);
        }
      } catch { /* ignore */ }
      onAbort();
    })();
  }, [token, current.questionId, onAbort]);

  // 随时手动结束整场面试(未答的题不再作答;链接随之失效)
  const endNow = useCallback(() => {
    if (busy === "submit") return; // 末题提交进行中,避免与提交并发触发重复收尾
    if (!window.confirm("确定现在结束本次面试吗?未作答的题目将不再作答,且本链接将无法再次进入。")) return;
    finishWholeInterview();
  }, [busy, finishWholeInterview]);

  // 整场总时长:到点(无论读题/答题)自动结束本轮;每秒刷新剩余
  const fwiRef = useRef(finishWholeInterview);
  useEffect(() => { fwiRef.current = finishWholeInterview; }, [finishWholeInterview]);
  useEffect(() => {
    if (!deadlineMs) return;
    let fired = false;
    const t = setInterval(() => {
      const left = Math.max(0, Math.round((deadlineMs - Date.now()) / 1000));
      setTotalLeft(left);
      if (left <= 0 && !fired) { fired = true; clearInterval(t); fwiRef.current(); }
    }, 1000);
    return () => clearInterval(t);
  }, [deadlineMs]);

  // 周期性在线心跳:避免长时间答单题被服务端误判为"离开"而锁定
  const qidRef = useRef(current.questionId); qidRef.current = current.questionId;
  useEffect(() => {
    const t = setInterval(() => { api.post(`/api/public/interview/${token}/presence`, { questionId: qidRef.current, stage: "interview" }); }, 60000);
    return () => clearInterval(t);
  }, [token]);

  // 托底②:看门狗 —— 只要界面不在"答题中",却还残留着录音器(说明某条路径切了界面但没正常停录),
  // 立刻强制释放麦克风。正常结束/重录/手动结束都已同步把 recRef 置空,这里只会在异常路径兜底,不会误伤。
  useEffect(() => {
    if (qStage !== "answering" && recRef.current) {
      try { recRef.current.cancel(); } catch { /* noop */ }
      recRef.current = null; setAnalyser(null);
    }
  }, [qStage]);

  // 托底③:组件卸载(切到完成页/作品页/任何离开本界面)时,无论如何都释放麦克风,杜绝"红点常亮、一直录音"。
  useEffect(() => () => { try { recRef.current?.cancel(); } catch { /* noop */ } recRef.current = null; }, []);

  // 读题倒计时(到点自动开始录音)
  useEffect(() => {
    if (qStage !== "reading") return;
    setReadLeft(READ_SECONDS);
    const t = setInterval(() => setReadLeft((s) => { if (s <= 1) { clearInterval(t); beginAnswer(); return 0; } return s - 1; }), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.questionId, qStage]);

  // 作答计时:不限时则只累计、不自动结束;限时则到上限自动结束并进下一题
  useEffect(() => {
    if (qStage !== "answering") return;
    const t = setInterval(() => setElapsed((s) => {
      if (!unlimited && s >= answerLimit - 1) { clearInterval(t); finishAndAdvance(); return answerLimit; }
      if (unlimited && s >= ANSWER_HARD_CAP_SECONDS - 1) { clearInterval(t); finishAndAdvance(); return ANSWER_HARD_CAP_SECONDS; } // 不限时下的安全上限
      return s + 1;
    }), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qStage]);

  useEffect(() => { api.post(`/api/public/interview/${token}/presence`, { questionId: current.questionId, stage: "interview" }); }, [current.questionId, token]);

  const pickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []); e.target.value = "";
    for (const f of files) {
      setBusy("img");
      try {
        const dataUrl = await resizeImage(f);
        const r = await api.post(`/api/public/interview/${token}/questions/${current.questionId}/image`, { imageBase64: dataUrl, name: f.name });
        if (r.ok) setImages((xs) => [...xs, dataUrl]); else setErr("图片上传失败。");
      } catch { setErr("图片处理失败。"); }
      setBusy("");
    }
  };

  const uploader = (
    <div className="upload-zone">
      <label className="btn ghost sm upload-btn">
        + 添加作品 / 截图(可多张)
        <input type="file" accept="image/*" multiple hidden onChange={pickImage} />
      </label>
      {busy === "img" && <span className="muted small">上传中…</span>}
      {images.length > 0 && (
        <div className="thumbs">{images.map((src, i) => <img key={i} src={src} className="thumb" alt={`作品${i + 1}`} />)}</div>
      )}
    </div>
  );

  const answeredNum = Math.min(idx + 1, total);

  return (
    <div className="page">
      <header className="brand-bar">
        <div className="brand-logo">{brand}</div>
        <div className="who-inline">
          {role && <span className="who-role">{role}</span>}
          {name && <span className="who-name">{name}</span>}
          <button className="btn ghost sm end-btn" onClick={endNow}>结束面试</button>
        </div>
      </header>

      <div className="progress-row">
        <span className="progress-text">第 {answeredNum} / {total} 题</span>
        <div className="progress-bar"><div className="progress-fill" style={{ width: `${(answeredNum / total) * 100}%` }} /></div>
        {deadlineMs > 0 && <span className={"total-left" + (totalLeft <= 120 ? " urgent" : "")}>本轮剩余 {fmt(totalLeft)}</span>}
      </div>
      {deadlineMs > 0 && totalLeft <= 120 && (
        <p className="warn small center-text" style={{ margin: "2px 0 0" }}>本轮总时间即将结束,到点将自动提交;请抓紧完成。</p>
      )}

      <main className="page-body wide">
        <div className="q-panel">
          <p className="q-text">{current.originalQuestion}</p>

          {qStage === "reading" && (
            <div className="q-act center-text">
              <div className="timer big">{readLeft}s</div>
              <p className="muted">读题时间,{readLeft} 秒后自动开始录音;也可以现在就开始。</p>
              <button className="btn primary lg" onClick={beginAnswer}>开始回答</button>
              {uploader}
            </div>
          )}

          {qStage === "answering" && (
            <div className="q-act">
              <Waveform analyser={analyser} active />
              <div className="rec-row">
                <span className="rec-dot" /> <span className="timer rec">{fmt(elapsed)}</span>
                {!unlimited && <span className="muted small">/ {fmt(answerLimit)}</span>}
              </div>
              <p className="muted center-text">正在录音 · 请结合真实经历回答{unlimited ? " · 答完点下方结束" : ""}</p>
              {uploader}
              <div className="row center" style={{ marginTop: 4 }}>
                <button className="btn ghost" onClick={reRecord} disabled={!!busy}>重新录制</button>
              </div>
              <button className="btn primary lg wide" onClick={finishAndAdvance}>
                {isLast ? "结束回答,提交面试" : "结束回答,进入下一题"}
              </button>
            </div>
          )}

          {err && <p className="warn center-text">{err}</p>}
        </div>
      </main>

      <footer className="page-foot muted">请结合真实经历回答 · 录音结束即自动保存,无需等待</footer>
    </div>
  );
}

// ───────── 二面预约页(沿用) ─────────
function BookingPage({ token }: { token: string }) {
  const [data, setData] = useState<{ candidateName?: string; slots?: any[]; pickedIndex?: number | null } | null>(null);
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/public/booking/${token}`).then((r) => r.json()).then((res) => {
      if (!res.ok) { setErr("链接无效或已失效。"); return; }
      setData(res); setPicked(res.pickedIndex ?? null);
    }).catch(() => setErr("网络错误。"));
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const pick = async (i: number) => {
    setErr(""); setBusy(true);
    try {
      const r = await api.post(`/api/public/booking/${token}/pick`, { index: i });
      if (r.ok) setPicked(i);
      else if (r.error === "slot_taken") { setErr("抱歉,这个时间刚被其他候选人预约了,请另选一个。"); load(); }
      else setErr("提交失败,请重试。");
    } catch { setErr("网络错误,请重试。"); }
    setBusy(false);
  };

  if (err) return <Shell brand="二面预约"><div className="panel danger"><h2>无法预约</h2><p className="muted">{err}</p></div></Shell>;
  if (!data) return <Shell brand="二面预约"><p className="muted center-text">加载中…</p></Shell>;
  const wd = (d: string) => "日一二三四五六"[new Date(d).getDay()] || "";
  return (
    <Shell brand="二面预约" name={data.candidateName}>
      <div className="panel">
        <h2>选择二面时间</h2>
        <p className="muted">{data.candidateName ? `${data.candidateName},` : ""}恭喜通过初轮。请从下面面试官给你的时间里选一个进行真人二面(视频会议)。</p>
        {picked != null && data.slots?.[picked] && (
          <div className="saved-badge" style={{ marginTop: 12 }}>
            已选:{data.slots[picked].date} 周{wd(data.slots[picked].date)} {data.slots[picked].start}-{data.slots[picked].end}
          </div>
        )}
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          {(data.slots || []).map((s, i) => {
            const taken = s.taken && picked !== i; // 被别人占用(本人已选的那个不算)
            return (
              <button key={i} className={`btn ${picked === i ? "primary" : ""}`} style={{ textAlign: "left", opacity: taken ? 0.5 : 1 }} disabled={busy || taken} onClick={() => pick(i)}>
                {s.date} 周{wd(s.date)} · {s.start}-{s.end}{picked === i ? "  ✓ 已选" : taken ? "  · 已被预约" : ""}
              </button>
            );
          })}
        </div>
        {err && <p className="warn" style={{ marginTop: 10 }}>{err}</p>}
      </div>
    </Shell>
  );
}

// 社招收集·基础资料表格(视频/问答前先填)
function BasicInfoForm({ token, brand, name, role, type, fields, existing, onDone }: { token: string; brand: string; name?: string; role?: string; type?: string; fields: Array<{ key: string; label: string; type: string; options?: string[]; required?: boolean }>; existing?: Record<string, string>; onDone: () => void }) {
  const [form, setForm] = useState<Record<string, string>>(existing || {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: string, v: string) => setForm((s) => ({ ...s, [k]: v }));
  const save = async () => {
    const missing = fields.filter((f) => f.required && !String(form[f.key] || "").trim());
    if (missing.length) { setErr("请先填写:" + missing.map((f) => f.label).join("、")); return; }
    const phone = form.phone || "";
    if (phone && !/^1[3-9]\d{9}$/.test(phone.replace(/\D/g, ""))) { setErr("请填写正确的 11 位手机号。"); return; }
    setErr(""); setBusy(true);
    try { const r = await api.post(`/api/public/collect/${token}/basic`, { info: form }); if (r.ok) onDone(); else setErr("保存失败,请重试。"); }
    catch { setErr("网络错误,请重试。"); }
    setBusy(false);
  };
  return (
    <Shell brand={brand} role={role} name={name}>
      <div className="panel">
        <h2>先填一下基本资料</h2>
        <p className="muted">{name ? `${name},` : ""}请先填好下面的基础信息,再开始{type === "anchor" ? "视频面试" : "问答"}。带 <b style={{ color: "var(--warn)" }}>*</b> 为必填。</p>
        {fields.map((f) => (
          <div key={f.key} style={{ marginTop: 4 }}>
            <label>{f.label}{f.required ? " *" : ""}</label>
            {f.type === "select"
              ? <select value={form[f.key] || ""} onChange={(e) => set(f.key, e.target.value)}><option value="">请选择</option>{(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
              : <input type={f.type === "number" ? "number" : (f.key === "phone" ? "tel" : "text")} inputMode={f.type === "number" || f.key === "phone" ? "numeric" : undefined} value={form[f.key] || ""} onChange={(e) => set(f.key, e.target.value)} placeholder={`请填写${f.label}`} />}
          </div>
        ))}
        {err && <p className="warn">{err}</p>}
        <button className="btn primary lg wide" style={{ marginTop: 16 }} onClick={save} disabled={busy}>{busy ? "保存中…" : "保存,开始面试 →"}</button>
      </div>
    </Shell>
  );
}

// ───────── 社招资料收集(无简历候选人:一问一答;主播岗含视频录入)─────────
function CollectPage({ token }: { token: string }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [brand, setBrand] = useState("资料收集");
  const [stage, setStage] = useState<"loading" | "basic" | "qa" | "video" | "done" | "error">("loading");
  const [idx, setIdx] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/settings/brand`).then((r) => r.json()).then((b) => { if (b.ok && b.brand?.companyName) setBrand(`${b.brand.companyName} · 资料收集`); }).catch(() => undefined);
    fetch(`/api/public/collect/${token}`).then((r) => r.json()).then((res) => {
      if (!res.ok) { setErr("链接无效或已失效。"); setStage("error"); return; }
      setData(res);
      if (res.status === "done") { setStage("done"); return; }
      if (!res.basicDone) { setStage("basic"); return; }   // 先填基础资料
      const qs = res.questions || [], ans = res.answers || {};
      const first = qs.findIndex((q: any) => !ans[q.id]);
      const start = first < 0 ? 0 : first;
      setIdx(start); setText(ans[qs[start]?.id] || ""); setStage("qa");
    }).catch(() => { setErr("网络错误,请稍后重试。"); setStage("error"); });
  }, [token]);

  const questions = data?.questions || [];
  const cur = questions[idx];
  const isLastQ = idx >= questions.length - 1;
  const isAnchor = data?.type === "anchor";
  const anchorVideo = isAnchor && !!data?.cosUpload; // 主播岗 + COS 可用 -> 每题视频回答
  const [curAnswered, setCurAnswered] = useState(false);
  useEffect(() => { setCurAnswered(!!(data?.answers || {})[cur?.id]); }, [idx, cur?.id]); // 切题时按已有答案重置

  const saveAnswer = async () => { if (cur) { try { await api.post(`/api/public/collect/${token}/answer`, { qid: cur.id, text }); data.answers = { ...(data.answers || {}), [cur.id]: text }; } catch { /* 忽略 */ } } };
  const submit = async (): Promise<boolean> => {
    setBusy(true);
    try { const r = await api.post(`/api/public/collect/${token}/submit`); if (r.ok) { setStage("done"); return true; } setErr("提交失败,请重试。"); }
    catch { setErr("网络错误。"); }
    setBusy(false); return false;
  };
  const next = async () => {
    setBusy(true);
    if (!anchorVideo) await saveAnswer(); // 视频回答已由服务端在转写时存好,无需再存文字
    if (!isLastQ) { const ni = idx + 1; setIdx(ni); setText((data.answers || {})[questions[ni].id] || ""); setBusy(false); }
    else if (isAnchor) { setStage("video"); setBusy(false); }
    else { await submit(); }
  };
  const prev = () => { if (idx > 0) { const pi = idx - 1; setIdx(pi); setText((data.answers || {})[questions[pi].id] || ""); } };

  if (stage === "loading") return <Shell brand={brand}><p className="muted center-text">加载中…</p></Shell>;
  if (stage === "error") return <Shell brand={brand}><div className="panel danger"><h2>无法打开</h2><p className="muted">{err}</p></div></Shell>;
  if (stage === "done") return (
    <Shell brand={brand} name={data?.candidateName}>
      <div className="panel success center-text" style={{ padding: "40px 24px" }}>
        <div className="big-check"><i /></div>
        <h2 style={{ fontSize: 24 }}>✅ 已完成本场面试</h2>
        <p className="muted" style={{ fontSize: 15, marginTop: 10 }}>感谢{data?.candidateName ? ` ${data.candidateName} ` : "你"}的参与!你的资料{isAnchor ? "和视频" : ""}已全部提交成功,我们会尽快查看并与你联系,请保持电话畅通。</p>
        <p className="muted small" style={{ marginTop: 12 }}>可以关闭本页面了。</p>
      </div>
    </Shell>
  );
  if (stage === "basic") return <BasicInfoForm token={token} brand={brand} name={data.candidateName} role={data.role} type={data.type} fields={data.basicFields || []} existing={data.basicInfo || {}} onDone={() => { const qs = data.questions || [], ans = data.answers || {}; const first = qs.findIndex((q: any) => !ans[q.id]); const start = first < 0 ? 0 : first; setIdx(start); setText(ans[qs[start]?.id] || ""); setStage("qa"); }} />;
  if (stage === "video") return <CollectVideo token={token} brand={brand} name={data.candidateName} busy={busy} cosUpload={data.cosUpload} pitchProduct={data.pitchProduct} onSubmit={submit} />;
  return (
    <Shell brand={brand} role={data.role} name={data.candidateName}>
      <div className="panel">
        <p className="muted">{data.candidateName ? `${data.candidateName},` : ""}{anchorVideo ? "请对着镜头逐题录视频回答,系统会自动转成文字。" : "请如实填写下面的问题,帮助我们快速了解你。"}{isAnchor ? "最后还有一段对镜头的整体形象展示。" : ""}可随时回上一题。</p>
        <div className="progress-row" style={{ marginTop: 8 }}>
          <span className="progress-text">第 {idx + 1} / {questions.length} 题</span>
          <div className="progress-bar"><div className="progress-fill" style={{ width: `${((idx + 1) / questions.length) * 100}%` }} /></div>
        </div>
        {cur?.category && <div className="muted small" style={{ marginTop: 10 }}>【{cur.category}】</div>}
        <h2 style={{ marginTop: 4 }}>{cur?.q}</h2>
        {cur?.hint && <p className="muted small" style={{ marginTop: 0 }}>{cur.hint}</p>}
        {anchorVideo
          ? <QuestionVideo key={cur?.id} token={token} qid={cur?.id} existing={(data.answers || {})[cur?.id]} onAnswered={() => { data.answers = { ...(data.answers || {}), [cur.id]: (data.answers || {})[cur.id] || "（视频已录,转写中）" }; setCurAnswered(true); }} />
          : <textarea style={{ minHeight: 120 }} placeholder="在这里填写你的回答…" value={text} onChange={(e) => setText(e.target.value)} />}
        {err && <p className="warn">{err}</p>}
        <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <button className="btn ghost" onClick={prev} disabled={idx === 0 || busy}>← 上一题</button>
          <button className="btn primary lg" onClick={next} disabled={busy || (anchorVideo && !curAnswered)}>{busy ? "保存中…" : (anchorVideo && !curAnswered) ? "先录一段回答" : isLastQ ? (isAnchor ? "下一步:形象展示 →" : "提交资料 →") : "下一题 →"}</button>
        </div>
      </div>
    </Shell>
  );
}

// 主播岗·单题视频回答:录一段 → 直传 COS → 立即可下一题(转写在后台跑,不让候选人等)
const QV_SOFT = 90, QV_HARD = 180; // 90s 软提示可继续,180s 硬停
function QuestionVideo({ token, qid, existing, onAnswered }: { token: string; qid: string; existing?: string; onAnswered: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("video/webm");
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const [recording, setRecording] = useState(false);
  const [phase, setPhase] = useState<"idle" | "uploading" | "done">(existing ? "done" : "idle");
  const [seconds, setSeconds] = useState(0);
  const [overLimit, setOverLimit] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: true });
        streamRef.current = s;
        if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.muted = true; await videoRef.current.play().catch(() => undefined); }
      } catch { setErr("无法访问摄像头/麦克风,请在浏览器允许权限后刷新。"); }
    })();
    return () => { streamRef.current?.getTracks().forEach((t) => t.stop()); if (tick.current) clearInterval(tick.current); };
  }, []);

  // 录完即上传 + 通知服务端,立即标记"已录好"。转写在服务端后台跑,候选人不必等。
  const uploadAndDone = useCallback(async () => {
    const ext = mimeRef.current.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    setPhase("uploading"); setProgress(0); setErr("");
    try {
      const pre = await api.post(`/api/public/collect/${token}/answer-video-presign`, { qid, ext });
      if (!pre.ok || !pre.uploadUrl) { setErr("上传准备失败,请重录。"); setPhase("idle"); return; }
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", pre.uploadUrl); xhr.setRequestHeader("Content-Type", mimeRef.current); xhr.timeout = 300000;
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("put_" + xhr.status)));
        xhr.onerror = () => reject(new Error("put_err")); xhr.ontimeout = () => reject(new Error("put_timeout"));
        xhr.send(blob);
      });
      await api.post(`/api/public/collect/${token}/answer-video-done`, { qid, key: pre.key }); // 不等转写
      setPhase("done"); onAnswered();
    } catch { setErr("上传失败,请重录再试。"); setPhase("idle"); }
  }, [token, qid, onAnswered]);

  const stopRec = () => { const mr = recRef.current; if (!mr || mr.state !== "recording") return; mr.stop(); setRecording(false); if (tick.current) clearInterval(tick.current); };
  const startRec = () => {
    const s = streamRef.current; if (!s) return;
    setErr(""); setOverLimit(false); chunksRef.current = [];
    const MR: any = (window as any).MediaRecorder;
    const mime = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((t) => MR?.isTypeSupported?.(t)) || "";
    let mr: MediaRecorder;
    try { mr = new MediaRecorder(s, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 } as any); }
    catch { try { mr = new MediaRecorder(s); } catch { setErr("当前浏览器不支持视频录制,建议用 Chrome 或手机自带浏览器。"); return; } }
    mimeRef.current = mr.mimeType || mime || "video/webm";
    recRef.current = mr;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    mr.onstop = () => { uploadAndDone(); };
    mr.start(); setRecording(true); setSeconds(0);
    tick.current = setInterval(() => setSeconds((x) => {
      const n = x + 1;
      if (n >= QV_SOFT) setOverLimit(true);                                  // 软提示:可继续,也可结束
      if (n >= QV_HARD && recRef.current?.state === "recording") stopRec();   // 硬上限自动停
      return n;
    }), 1000);
  };

  return (
    <div className="qvid">
      <div className="cam-box"><video ref={videoRef} playsInline muted className="cam" /></div>
      {err && <p className="warn">{err}</p>}
      {recording && <div className="rec-row" style={{ justifyContent: "center" }}><span className="rec-dot" /> <span className="timer rec">录制中 {seconds}s</span></div>}
      {recording && overLimit && <p className="warn" style={{ marginTop: 6 }}>已录 {QV_SOFT} 秒。说完了就点「录完了」;没说完可以继续说,最长 {QV_HARD} 秒。</p>}
      {phase === "uploading" && (
        <div className="works-uploading" style={{ marginTop: 8 }}>
          <div className="works-progress"><div className="works-progress-fill" style={{ width: `${progress}%` }} /></div>
          <span className="muted small">视频上传中… {progress}%</span>
        </div>
      )}
      {phase === "done" && <div className="qvid-transcript"><div className="small">✓ 这题已录好,系统正在<b>自动转成文字</b>,无需等待,可直接进入下一题。</div></div>}
      <div className="row center" style={{ marginTop: 10 }}>
        {!recording && phase !== "uploading" && <button className="btn primary lg" onClick={startRec} disabled={!!err}>{phase === "done" ? "重录这题" : "● 开始录制回答"}</button>}
        {recording && <button className="btn primary lg" onClick={stopRec}>■ 录完了</button>}
      </div>
    </div>
  );
}

function CollectVideo({ token, brand, name, busy, cosUpload, pitchProduct, onSubmit }: { token: string; brand: string; name?: string; busy: boolean; cosUpload?: boolean; pitchProduct?: string | null; onSubmit: () => boolean | Promise<boolean> }) {
  const [submitErr, setSubmitErr] = useState("");
  const doSubmit = async () => { setSubmitErr(""); const ok = await onSubmit(); if (!ok) setSubmitErr("提交失败,请检查网络后重试。"); };
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("video/webm");
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [err, setErr] = useState("");

  const captureFrame = useCallback(() => {
    const v = videoRef.current; if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    api.post(`/api/public/collect/${token}/frame`, { imageBase64: c.toDataURL("image/jpeg", 0.8) }).catch(() => undefined);
  }, [token]);

  useEffect(() => {
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: true });
        streamRef.current = s;
        if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.muted = true; await videoRef.current.play().catch(() => undefined); }
      } catch { setErr("无法访问摄像头/麦克风,请在浏览器允许权限后刷新。"); }
    })();
    return () => { streamRef.current?.getTracks().forEach((t) => t.stop()); if (tick.current) clearInterval(tick.current); };
  }, []);

  // 经隧道上传(回退方案):POST 二进制到本地服务端。隧道较慢,大文件可能超时。
  const tunnelUpload = useCallback((blob: Blob, ext: string) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/public/collect/${token}/video`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("x-ext", ext);
    xhr.timeout = 180000;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) setRecorded(true); else if (xhr.status === 413) setErr("视频太大被拒,请录短一点再试。"); else setErr(`视频上传失败(${xhr.status}),可重录再试。`); setUploading(false); };
    xhr.onerror = () => { setErr("视频上传失败,请检查网络后重录。"); setUploading(false); };
    xhr.ontimeout = () => { setErr("上传超时(网络较慢),请换个网络或录短一点再试。"); setUploading(false); };
    xhr.send(blob);
  }, [token]);

  // 直传腾讯云 COS(首选,绕开隧道、快):申请预签名 PUT URL → 浏览器直传 COS → 通知服务端。COS 失败则回退隧道。
  const upload = useCallback(() => {
    setUploading(true); setProgress(0);
    const ext = mimeRef.current.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    if (blob.size > 95 * 1024 * 1024) { setErr("视频太大,请录短一点(建议 30 秒内)再试。"); setUploading(false); return; }
    if (!cosUpload) { tunnelUpload(blob, ext); return; }
    api.post(`/api/public/collect/${token}/video-presign`, { ext }).then((pre) => {
      if (!pre.ok || !pre.uploadUrl) { tunnelUpload(blob, ext); return; }
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", pre.uploadUrl);
      xhr.setRequestHeader("Content-Type", mimeRef.current);
      xhr.timeout = 300000;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          api.post(`/api/public/collect/${token}/video-cos-done`, { key: pre.key }).then(() => setRecorded(true)).catch(() => setErr("视频已传,记录失败,请重试。")).finally(() => setUploading(false));
        } else { setErr(`视频上传失败(${xhr.status}),正在改用备用通道…`); tunnelUpload(blob, ext); }
      };
      xhr.onerror = () => { tunnelUpload(blob, ext); };   // COS 直传失败(如未配 CORS)→ 回退隧道
      xhr.ontimeout = () => { setErr("上传超时,请重录再试。"); setUploading(false); };
      xhr.send(blob);
    }).catch(() => tunnelUpload(blob, ext));
  }, [token, cosUpload, tunnelUpload]);

  const startRec = () => {
    const s = streamRef.current; if (!s) return;
    setErr(""); chunksRef.current = [];
    // 选浏览器支持的格式 + 低码率(视频 ~1Mbps、音频 64kbps),大幅减小文件、避免经隧道上传超时
    const MR: any = (window as any).MediaRecorder;
    const mime = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((t) => MR?.isTypeSupported?.(t)) || "";
    let mr: MediaRecorder;
    try { mr = new MediaRecorder(s, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 } as any); }
    catch { try { mr = new MediaRecorder(s); } catch { setErr("当前浏览器不支持视频录制,建议用 Chrome 或手机自带浏览器。"); return; } }
    mimeRef.current = mr.mimeType || mime || "video/webm";
    recRef.current = mr;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    mr.onstop = () => { captureFrame(); upload(); };
    mr.start(); setRecording(true); setSeconds(0);
    captureFrame();
    tick.current = setInterval(() => setSeconds((x) => {
      const n = x + 1;
      if (n % 5 === 0) captureFrame();        // 每 5 秒自动截一帧
      if (n >= 60 && recRef.current?.state === "recording") stopRec(); // 最长 60s 自动停
      return n;
    }), 1000);
  };
  const stopRec = () => { const mr = recRef.current; if (!mr || mr.state !== "recording") return; mr.stop(); setRecording(false); if (tick.current) clearInterval(tick.current); };

  return (
    <Shell brand={brand} name={name}>
      <div className="panel center-text">
        <h2>最后一步:对镜头「直播带货」</h2>
        {pitchProduct ? (
          <div className="pitch-box">
            <div className="small">🎬 现在请你进入<b>直播间</b>,把下面这件商品卖给观众:</div>
            <div className="pitch-product">{pitchProduct}</div>
            <p className="muted small" style={{ marginTop: 6 }}>对着镜头<b>声情并茂、像真的在直播一样</b>推荐它,讲清卖点、调动情绪、有感染力(<b>30–60 秒</b>)。这一环节考察你的镜头表现与表达力。</p>
          </div>
        ) : (
          <p className="muted">请正对镜头,<b>介绍一下自己,展示你的状态与风格</b>(建议 20–30 秒)。这一环节考察你的镜头表现与表达力。</p>
        )}
        <div className="cam-box"><video ref={videoRef} playsInline muted className="cam" /></div>
        {err && <p className="warn">{err}</p>}
        {recording && <div className="rec-row" style={{ justifyContent: "center" }}><span className="rec-dot" /> <span className="timer rec">录制中 {seconds}s / 60s</span></div>}
        <div className="row center" style={{ marginTop: 10 }}>
          {!recording && !recorded && <button className="btn primary lg" onClick={startRec} disabled={!!err || uploading}>● 开始录制</button>}
          {recording && <button className="btn primary lg" onClick={stopRec}>■ 停止录制</button>}
          {recorded && !recording && <button className="btn ghost" onClick={() => { setRecorded(false); startRec(); }} disabled={uploading}>重录</button>}
          {recorded && !recording && <button className="btn primary lg" onClick={doSubmit} disabled={busy || uploading}>{busy ? "提交中…" : "提交资料,完成 →"}</button>}
        </div>
        {submitErr && <p className="warn">{submitErr}</p>}
        {uploading && (
          <div className="works-uploading" style={{ marginTop: 10 }}>
            <div className="works-progress"><div className="works-progress-fill" style={{ width: `${progress}%` }} /></div>
            <span className="muted small">视频上传中… {progress}%(请勿关闭页面)</span>
          </div>
        )}
        {recorded && !uploading && <p className="muted small">✓ 视频已录好。可重录,或直接提交。</p>}
      </div>
    </Shell>
  );
}

// ───────── 候选人档案只读分享页(凭 share token,发给 HR/他人查看) ─────────
const COMM_TYPE: Record<string, string> = { comm: "沟通", interview: "面试安排", note: "备注" };

function answerText(q: any): string {
  return (q.answerSummary || q.correctedTranscript || q.rawTranscript || "").trim();
}

function DossierQuestion({ q, atts, token }: { q: any; atts: any[]; token: string }) {
  const ans = answerText(q);
  const judge = q.judge || null;
  const qAtts = atts.filter((a) => a.questionId === q.questionId);
  return (
    <div className="dq">
      <div className="dq-head">
        <span className="dq-ord">第 {(q.ord ?? 0) + 1} 题</span>
        {q.dimension && <span className="dq-dim">{q.dimension}</span>}
        {judge?.grade && <span className={"dq-grade g" + judge.grade}>{judge.grade}{typeof judge.score === "number" ? ` · ${judge.score}分` : ""}</span>}
      </div>
      <p className="dq-q">{q.originalQuestion}</p>
      {q.followUpQuestion && <p className="dq-follow">追问:{q.followUpQuestion}</p>}
      <div className="dq-a">
        <div className="dq-label">候选人回答{q.answerSummary ? "(整理稿)" : ""}</div>
        {ans ? <p className="dq-a-text">{ans}</p> : <p className="muted small">未作答 / 无转写</p>}
      </div>
      {qAtts.length > 0 && (
        <div className="dq-atts">
          {qAtts.map((a) => a.type === "video"
            ? <video key={a.id} className="dq-media" src={`/api/public/share/${token}/attachments/${a.id}/file`} controls preload="metadata" />
            : <img key={a.id} className="dq-media" src={`/api/public/share/${token}/attachments/${a.id}/file`} alt={a.name || "附件"} />)}
        </div>
      )}
      {judge && (judge.summary || (judge.quotes?.length) || (judge.gaps?.length)) && (
        <div className="dq-judge">
          {judge.summary && <p className="dq-judge-sum"><b>AI 评判:</b>{judge.summary}</p>}
          {Array.isArray(judge.quotes) && judge.quotes.length > 0 && (
            <div className="dq-judge-row"><span className="dq-judge-k">亮点原话</span><ul>{judge.quotes.map((x: any, i: number) => <li key={i}>{typeof x === "string" ? x : (x?.quote || x?.text || "")}</li>)}</ul></div>
          )}
          {Array.isArray(judge.gaps) && judge.gaps.length > 0 && (
            <div className="dq-judge-row"><span className="dq-judge-k">未讲清</span><ul>{judge.gaps.map((x: any, i: number) => <li key={i}>{typeof x === "string" ? x : (x?.point || x?.text || "")}</li>)}</ul></div>
          )}
        </div>
      )}
    </div>
  );
}

function SharePage({ token }: { token: string }) {
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");
  const [err, setErr] = useState("");
  const [d, setD] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/public/share/${token}`).then((r) => r.json()).then((res) => {
      if (!res.ok) {
        const map: Record<string, string> = {
          not_found: "链接无效或不存在。", revoked: "该分享链接已被撤销。",
          expired: "该分享链接已过期。", exhausted: "该分享链接已达查看次数上限。",
          candidate_gone: "该候选人资料已不存在。",
        };
        setErr(map[res.error] || "链接无法访问。"); setState("error"); return;
      }
      setD(res.dossier); setMeta(res.meta); setState("ok");
    }).catch(() => { setErr("网络错误,请稍后重试。"); setState("error"); });
  }, [token]);

  if (state === "loading") return <Shell brand="候选人档案"><p className="muted center-text">加载中…</p></Shell>;
  if (state === "error") return <Shell brand="候选人档案"><div className="panel danger center-text"><h2>无法查看</h2><p className="muted">{err}</p></div></Shell>;

  const p = d.profile || {};
  const sc = d.screening;
  const iv = d.interview;
  const ev = d.evaluation;
  const raw = ev?.raw || {};
  const atts: any[] = d.attachments || [];
  const comms: any[] = d.communications || [];
  const booking = d.secondInterview?.booking;
  const result = d.result?.result as ("pass" | "reject" | null);
  const questions = Array.isArray(iv?.questions) ? [...iv.questions].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0)) : [];
  const resultBadge = result === "pass" ? { t: "已录用", c: "pass" } : result === "reject" ? { t: "未录用", c: "reject" } : { t: "评估中 / 待定", c: "pending" };
  const commDate = (c: any) => { const t = c.startTime ? ` ${c.startTime}${c.endTime ? "-" + c.endTime : ""}` : ""; return `${c.date}${t}`; };

  return (
    <div className="page dossier">
      <header className="brand-bar">
        <div className="brand-logo">{p.name || "候选人档案"}</div>
        <div className="brand-tag">面试情况 · 只读分享</div>
      </header>
      <main className="page-body wide">
        {/* 顶部概览 */}
        <div className="ds-hero">
          {p.photo && <img className="ds-avatar" src={p.photo} alt={p.name} />}
          <div className="ds-hero-main">
            <div className="ds-name">{p.name}<span className={"ds-result " + resultBadge.c}>{resultBadge.t}</span></div>
            <div className="ds-sub muted">{p.positionRole || p.role}{p.priority ? ` · ${p.priority}` : ""}{sc?.rating ? ` · 初筛 ${sc.rating}` : ""}</div>
            <div className="ds-meta muted small">
              {meta?.viewsLeft != null ? `本链接剩余可查看 ${meta.viewsLeft} 次` : "本链接不限查看次数"}
              {meta?.validUntil ? ` · 有效期至 ${meta.validUntil.slice(0, 16).replace("T", " ")}` : ""}
            </div>
          </div>
        </div>

        {/* (a) 个人资料 */}
        <section className="ds-sec">
          <h2 className="ds-h">① 个人资料</h2>
          <div className="ds-grid">
            {p.source && <div className="ds-kv"><span>来源</span><b>{p.source}</b></div>}
            {p.collectedDate && <div className="ds-kv"><span>收录</span><b>{p.collectedDate}</b></div>}
            {(p.eduSchoolName || p.eduDegree) && <div className="ds-kv"><span>学历</span><b>{[p.eduSchoolName, p.eduDegree].filter(Boolean).join(" · ")}</b></div>}
            {p.locationCurrent && <div className="ds-kv"><span>现居</span><b>{p.locationCurrent}</b></div>}
            {p.locationExpect && <div className="ds-kv"><span>期望</span><b>{p.locationExpect}</b></div>}
            {p.phone && <div className="ds-kv"><span>联系方式</span><b>{p.phone}</b></div>}
          </div>
          {p.resumeText && (
            <div className="ds-resume">
              <div className="ds-label">简历</div>
              <pre className="ds-resume-text">{p.resumeText}</pre>
            </div>
          )}
        </section>

        {/* (b) 沟通记录 */}
        <section className="ds-sec">
          <h2 className="ds-h">② 沟通记录</h2>
          {comms.length === 0 && !booking ? <p className="muted small">暂无沟通记录。</p> : (
            <div className="ds-comms">
              {comms.map((c, i) => (
                <div key={i} className="ds-comm">
                  <span className={"ds-comm-type " + c.type}>{COMM_TYPE[c.type] || "记录"}</span>
                  <div className="ds-comm-body">
                    <div className="ds-comm-title"><b>{c.title}</b> <span className="muted small">{commDate(c)}</span>{c.outcome && <span className="ds-outcome">{c.outcome}</span>}</div>
                    {c.note && <div className="muted small">{c.note}</div>}
                  </div>
                </div>
              ))}
              {booking && (
                <div className="ds-comm">
                  <span className="ds-comm-type interview">二面</span>
                  <div className="ds-comm-body">
                    <div className="ds-comm-title"><b>二面预约</b> <span className="muted small">{booking.slot ? `${booking.slot.date} ${booking.slot.start || ""}${booking.slot.end ? "-" + booking.slot.end : ""}` : ""}</span></div>
                    <div className="muted small">状态:{booking.reviewStatus === "approved" ? "已确认" : booking.reviewStatus === "rejected" ? "已拒绝/改约" : "待确认"}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* (c) 面试情况与评价 */}
        <section className="ds-sec">
          <h2 className="ds-h">③ 面试情况与评价</h2>
          {sc && (
            <div className="ds-card">
              <div className="ds-label">AI 初筛结论 · {sc.rating}</div>
              {sc.summary && <p className="ds-p">{sc.summary}</p>}
              {Array.isArray(sc.reasons) && sc.reasons.length > 0 && (
                <ul className="ds-ul">{sc.reasons.map((r: any, i: number) => <li key={i}>{r.point}{r.quote ? <span className="muted">「{r.quote}」</span> : null}</li>)}</ul>
              )}
              {Array.isArray(sc.risks) && sc.risks.length > 0 && <p className="ds-risk">风险:{sc.risks.join(" · ")}</p>}
            </div>
          )}
          {questions.length > 0 ? (
            <div className="ds-qs">
              <div className="ds-label">AI 面试逐题({questions.length} 题{iv?.submittedAt ? ` · 提交于 ${String(iv.submittedAt).slice(0, 16).replace("T", " ")}` : ""})</div>
              {questions.map((q: any) => <DossierQuestion key={q.questionId} q={q} atts={atts} token={token} />)}
            </div>
          ) : <p className="muted small">尚未进行 AI 面试。</p>}
        </section>

        {/* (d) 整体评估与反馈 */}
        <section className="ds-sec">
          <h2 className="ds-h">④ 整体评估与反馈</h2>
          {ev ? (
            <div className="ds-card">
              <div className="ds-eval-head">
                {ev.recommendation && <span className={"ds-reco " + (ev.recommendation === "推荐" ? "yes" : ev.recommendation === "不推荐" ? "no" : "mid")}>{ev.recommendation}</span>}
                {ev.grade && <span className="ds-grade">综合 {ev.grade}{typeof ev.score === "number" ? ` · ${ev.score}分` : ""}</span>}
              </div>
              {ev.summary && <p className="ds-p">{ev.summary}</p>}
              {Array.isArray(raw.strengths) && raw.strengths.length > 0 && (
                <div className="ds-judge-row"><span className="ds-judge-k good">亮点</span><ul>{raw.strengths.map((x: any, i: number) => <li key={i}>{typeof x === "string" ? x : (x?.point || "")}</li>)}</ul></div>
              )}
              {Array.isArray(raw.concerns) && raw.concerns.length > 0 && (
                <div className="ds-judge-row"><span className="ds-judge-k bad">顾虑</span><ul>{raw.concerns.map((x: any, i: number) => <li key={i}>{typeof x === "string" ? x : (x?.point || "")}</li>)}</ul></div>
              )}
              {Array.isArray(ev.reviewChecklist) && ev.reviewChecklist.length > 0 && (
                <div className="ds-judge-row"><span className="ds-judge-k">二面复核清单</span><ul>{ev.reviewChecklist.map((x: any, i: number) => <li key={i}>{typeof x === "string" ? x : (x?.point || x?.question || "")}</li>)}</ul></div>
              )}
            </div>
          ) : <p className="muted small">尚未生成评估报告。</p>}
          <div className="ds-card ds-final">
            <div className="ds-label">最终结果</div>
            <p className="ds-p"><span className={"ds-result inline " + resultBadge.c}>{resultBadge.t}</span></p>
            {d.result?.note && <div className="ds-note">{d.result.note}</div>}
            {d.result?.at && <p className="muted small">决定时间:{String(d.result.at).slice(0, 10)}</p>}
          </div>
        </section>

        <p className="muted small center-text" style={{ marginTop: 18 }}>本页为候选人面试情况的只读分享,内容由系统按分享时状态生成 · 请勿转发无关人员。</p>
      </main>
    </div>
  );
}

function Root() {
  const shareToken = getShareToken();
  if (shareToken) return <SharePage token={shareToken} />;
  const bookingToken = getBookingToken();
  if (bookingToken) return <BookingPage token={bookingToken} />;
  const collectToken = getCollectToken();
  if (collectToken) return <CollectPage token={collectToken} />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(<Root />);
