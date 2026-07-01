// 人才详情页:档案 + 时间线(入库 -> 初筛 -> 邀约 -> AI面试逐题 -> 报告 -> 结果)。
import React, { useEffect, useState } from "react";
import { api, copyText } from "../api.js";
import { stageMeta } from "../stages.js";
import { SecondInterviewPanel } from "./second-interview.js";

export function CandidateDetail({ candidateId, onBack, toast }: { candidateId: string; onBack: () => void; toast: (m: string) => void }) {
  const [candidate, setCandidate] = useState<any>(null);
  const [screening, setScreening] = useState<any>(null);
  const [interview, setInterview] = useState<any>(null);
  const [evaluation, setEvaluation] = useState<any>(null);
  const [secondInterview, setSecondInterview] = useState<any>(null);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [photo, setPhoto] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null); // 点击放大查看的图片
  const [loading, setLoading] = useState(true);
  const [showLaunch, setShowLaunch] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [busy, setBusy] = useState("");

  const [loadErr, setLoadErr] = useState("");
  const load = async () => {
    // 一次性聚合请求(候选人+初筛+面试+评估+二面),只一次往返;照片懒加载
    setPhoto(null); setLoadErr("");
    let r: any = null, err: any = null;
    try { r = await api.candidateDetail(candidateId); } catch (e) { err = e; }
    if (!r || !r.candidate) { setCandidate(null); setLoadErr(err ? ((err as Error).message || "网络错误") : ""); setLoading(false); return; }
    setCandidate(r.candidate);
    setScreening(r.screening || null);
    setInterview(r.interview || null);
    setEvaluation(r.evaluation || null);
    setSecondInterview(r.secondInterview || null);
    setAttachments(Array.isArray(r.attachments) ? r.attachments : []);
    setLoading(false);
    if (r.candidate.hasPhoto) api.candidatePhoto(candidateId).then((p) => setPhoto(p.photo)).catch(() => undefined);
  };
  useEffect(() => { setLoading(true); load(); /* eslint-disable-next-line */ }, [candidateId]);

  const runScreen = async () => { setBusy("screen"); try { const r = await api.screenCandidate(candidateId); setScreening(r.screening); toast("初筛完成"); await load(); } catch (e) { toast("失败:" + (e as Error).message); } setBusy(""); };
  const genReport = async () => { if (!interview) return; if (evaluation && !window.confirm("重新生成会覆盖现有评估报告(逐题评判与整理稿也会重算)。确定?")) return; setBusy("report"); try { const r = await api.generateReport(interview.id); setEvaluation(r.evaluation); toast("报告已生成"); await load(); } catch (e) { toast("失败:" + (e as Error).message); } setBusy(""); };
  const reopen = async () => {
    if (!interview) return;
    if (!window.confirm("重新开启这场面试?将清空候选人原来的作答、转写与评判,用同一条链接让他重新从头作答,并把链接有效期续到设定时长。原报告在他重新提交后可再生成。")) return;
    setBusy("reopen");
    try { await api.reopenInterview(interview.id); toast("已重新开启 · 候选人可用原链接重新作答"); await load(); }
    catch (e) { toast("失败:" + (e as Error).message); }
    setBusy("");
  };
  const retranscribe = async () => {
    if (!interview) return;
    setBusy("retrans");
    try { const r = await api.retranscribeInterview(interview.id); toast(`重转完成:成功 ${r.retranscribed}/${r.total}${r.failed ? `,仍失败 ${r.failed}(服务可能还没恢复)` : ""}${r.skipped ? `,跳过 ${r.skipped}(候选人已重答)` : ""}`); await load(); }
    catch (e) { toast("重转失败:" + (e as Error).message); }
    setBusy("");
  };
  const removeCandidate = async () => {
    if (!candidate) return;
    if (!window.confirm(`确定删除候选人「${candidate.name}」吗?\n会一并删除其简历、面试、作答、作品与评估,不可恢复。`)) return;
    setBusy("delete");
    try { await api.deleteCandidate(candidate.id); toast(`已删除 ${candidate.name}`); onBack(); }
    catch (e) { toast("删除失败:" + (e as Error).message); setBusy(""); }
  };

  if (loading) return <p className="muted">加载中…</p>;
  if (!candidate) return <div><a onClick={onBack}>← 返回</a><p className="empty">{loadErr ? <>加载失败:{loadErr} <a onClick={() => { setLoading(true); load(); }}>重试</a></> : "候选人不存在"}</p></div>;
  const m = stageMeta(candidate.currentStage);
  // 转写失败但已备份录音、可一键重转的题数(服务恢复后用)
  const retranscribeCount = (interview?.questions || []).filter((q: any) => q.audioBackup && !(q.correctedTranscript || "").trim()).length;

  return (
    <div className="detail-page">
      <a onClick={onBack}>← 人才库</a>
      <div className="detail-head" style={{ marginTop: 10 }}>
        {photo && <img className="avatar" src={photo} alt={candidate.name} style={{ cursor: "zoom-in" }} title="点击放大" onClick={() => setZoom(photo)} />}
        <span className={"star-toggle" + (candidate.starred ? " on" : "")} style={{ cursor: "pointer", fontSize: 20 }} title={candidate.starred ? "取消收藏" : "收藏"}
          onClick={async () => { try { await api.setStar(candidate.id, !candidate.starred); await load(); } catch (e) { toast("收藏失败:" + (e as Error).message); } }}>
          {candidate.starred ? "★" : "☆"}
        </span>
        <h1>{candidate.name}</h1>
        <span className="stage-dot" style={{ background: m.color, width: 10, height: 10 }} />
        <span className="muted">{m.label}</span>
        <span className="muted">· {candidate.role}</span>
        {candidate.priority && <span className="grade B">{candidate.priority}</span>}
        <div style={{ marginLeft: "auto" }} className="row">
          <button className={"btn" + (candidate.starred ? " star-on" : "")} title={candidate.starred ? "取消收藏" : "收藏此候选人"}
            onClick={async () => { try { await api.setStar(candidate.id, !candidate.starred); await load(); } catch (e) { toast("收藏失败:" + (e as Error).message); } }}>
            {candidate.starred ? "★ 已收藏" : "☆ 收藏"}
          </button>
          {!screening && <button className="btn" onClick={runScreen} disabled={busy === "screen"}>{busy === "screen" ? "初筛中…" : "AI 初筛"}</button>}
          {screening && !interview && <button className="btn primary" onClick={() => setShowLaunch(true)}>发起 AI 面试</button>}
          {interview && <button className="btn primary" onClick={genReport} disabled={busy === "report"}>{busy === "report" ? "生成中…(逐题评判)" : evaluation ? "重新生成报告" : "生成报告"}</button>}
          {interview && <button className="btn" onClick={reopen} disabled={busy === "reopen"} title="用同一条链接让候选人重新作答(清空原作答)">{busy === "reopen" ? "开启中…" : "重新开启面试"}</button>}
          {retranscribeCount > 0 && <button className="btn" onClick={retranscribe} disabled={busy === "retrans"} title="转写服务恢复后,把转写失败但录音已备份的题重新转成文字,无需候选人重答">{busy === "retrans" ? "重转中…" : `🔄 重转失败题 (${retranscribeCount})`}</button>}
          {screening && interview && <button className="btn" onClick={() => setShowLaunch(true)}>重新发起面试</button>}
          <button className="btn" onClick={() => setShowShare(true)} title="生成只读分享链接,发给 HR 或他人查看该候选人完整面试情况(可设查看次数与有效期)">🔗 分享</button>
          <button className="btn" style={{ color: "var(--bad)", borderColor: "rgba(255,90,90,.4)" }} onClick={removeCandidate} disabled={busy === "delete"}>{busy === "delete" ? "删除中…" : "删除候选人"}</button>
        </div>
      </div>

      {interview && <LiveStatus candidateId={candidateId} />}

      <div className="detail-grid">
        {/* 左:档案(独立滚动)*/}
        <div className="detail-col">
          <div className="card">
            <div className="spread"><div className="section-h" style={{ marginTop: 0 }}>简历</div>{candidate.hasPhoto && <span className="muted small">📷 已采集本人照片</span>}</div>
            <p className="muted small">{candidate.source} · 收录 {candidate.collectedDate}</p>
            <LocationRow candidate={candidate} onSaved={load} toast={toast} />
            <ResumeView text={candidate.resumeText} />
          </div>
          <CollectionPanel candidateId={candidate.id} toast={toast} />
          {screening && <ScreeningCard screening={screening} />}
          {attachments.length > 0 && <AttachmentsCard items={attachments} onZoom={setZoom} />}
          <ResultCard candidate={candidate} onSaved={load} toast={toast} />
        </div>

        {/* 右:时间线(独立滚动)*/}
        <div className="detail-col timeline">
          <TL state="done" title="入库" body={<span className="muted small">{candidate.source} · {candidate.collectedDate}</span>} />
          <TL state={screening ? "done" : "wait"} title="AI 初筛"
            body={screening ? <span className="muted small">评级 {screening.rating} · 预生成 {screening.generatedQuestions?.length || 0} 道定制题</span> : <span className="muted small">尚未初筛</span>} />
          <TL state={interview ? "done" : screening ? "wait" : "todo"} title="邀约 AI 面试"
            body={interview ? <InviteLink interview={interview} toast={toast} /> : <span className="muted small">{screening ? "可发起面试" : "先完成初筛"}</span>} />
          {interview && (
            <TL state={interview.status === "completed" ? "done" : "wait"} title={`AI 面试逐题(${interview.questions?.length || 0} 题)`}
              body={<QuestionList interview={interview} />} />
          )}
          <TL state={evaluation ? "done" : interview?.status === "completed" ? "wait" : "todo"} title="评估报告 + 二面复核清单"
            body={evaluation ? <ReportView e={evaluation} /> : <span className="muted small">面试完成后生成</span>} />
          <TL state={secondInterview?.booking?.reviewStatus === "approved" ? "done" : (secondInterview?.booking || secondInterview?.invite || evaluation?.recommendation === "推荐" || interview?.status === "completed") ? "wait" : "todo"} title="二面预约(真人复核)"
            body={<SecondInterviewPanel candidateId={candidateId} toast={toast} initial={secondInterview} />} />
        </div>
      </div>

      {showLaunch && screening && (
        <LaunchModal candidate={candidate} screening={screening} onClose={() => setShowLaunch(false)} onLaunched={async () => { setShowLaunch(false); toast("面试已发起,链接已生成"); await load(); }} />
      )}

      {showShare && <ShareModal candidate={candidate} toast={toast} onClose={() => setShowShare(false)} />}

      {zoom && (
        <div className="modal-bg" onClick={() => setZoom(null)} style={{ cursor: "zoom-out" }}>
          <img className="zoom-img" src={zoom} alt="放大查看" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

// 候选人上传的作品 / 答题附图:图片可点开看大图,视频可在线播放
function fmtBytes(n?: number) {
  if (!n) return "";
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
  return Math.max(1, Math.round(n / 1024)) + "KB";
}
function AttCard({ a, onZoom }: { a: any; onZoom: (src: string) => void }) {
  return (
    <div className="att-card">
      {a.type === "video"
        ? <video className="att-media" src={a.url} controls preload="metadata" />
        : <img className="att-media" src={a.url} alt={a.name || "附件"} style={{ cursor: "zoom-in" }} title="点击放大" onClick={() => onZoom(a.url)} />}
      <div className="att-meta">
        <span className="att-name" title={a.name}>{a.type === "video" ? "🎬 " : "🖼 "}{a.name || (a.type === "video" ? "视频" : "图片")}</span>
        {a.size ? <span className="muted small">{fmtBytes(a.size)}</span> : null}
      </div>
    </div>
  );
}
function AttachmentsCard({ items, onZoom }: { items: any[]; onZoom: (src: string) => void }) {
  const portfolio = items.filter((a) => a.kind === "portfolio");
  const answerImgs = items.filter((a) => a.kind !== "portfolio");
  return (
    <div className="card">
      <div className="section-h" style={{ marginTop: 0 }}>候选人作品 / 附件</div>
      {portfolio.length > 0 && (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>代表作品 {portfolio.length} 个</p>
          <div className="att-grid">{portfolio.map((a) => <AttCard key={a.id} a={a} onZoom={onZoom} />)}</div>
        </>
      )}
      {answerImgs.length > 0 && (
        <>
          <p className="muted small">答题附图 {answerImgs.length} 张</p>
          <div className="att-grid">{answerImgs.map((a) => <AttCard key={a.id} a={a} onZoom={onZoom} />)}</div>
        </>
      )}
    </div>
  );
}

// 实时状态:候选人此刻进行到链接的哪一步(每 4s 轮询;已提交/已结束后停止)
function relTime(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
function LiveStatus({ candidateId }: { candidateId: string }) {
  const [live, setLive] = useState<any>(null);
  const [tick, setTick] = useState(0); // 驱动"最后活跃 X 秒前"刷新
  useEffect(() => {
    let alive = true; let timer: any;
    const poll = async () => {
      let stop = false;
      try {
        const r = await api.candidateLive(candidateId);
        if (!alive) return;
        setLive(r.live);
        stop = !r.live?.hasInterview || r.live.status === "completed" || r.live.gate === "locked";
      } catch { /* 忽略,下次再试 */ }
      if (alive && !stop) timer = setTimeout(poll, 4000);
    };
    poll();
    const rt = setInterval(() => setTick((t) => t + 1), 1000); // 每秒刷新相对时间
    return () => { alive = false; clearTimeout(timer); clearInterval(rt); };
  }, [candidateId]);
  void tick;
  if (!live || !live.hasInterview) return null;
  const cls = live.online ? "on" : (live.status === "completed" ? "done" : (live.gate === "locked" ? "ended" : ""));
  return (
    <div className={"live-banner " + cls}>
      <span className="live-dot" />
      <div className="live-main">
        <div className="live-detail">
          <b>{live.detail}</b>
          {live.online && <span className="live-on">● 在线</span>}
        </div>
        <div className="muted small">
          {live.questionTotal ? `已完成 ${live.answeredCount}/${live.questionTotal} 题 · ` : ""}
          {live.lastSeenAt ? `最后活跃 ${relTime(live.lastSeenAt)}` : "尚无活动"}
          {live.deadlineAt && live.gate === "ok" ? ` · 本轮截止 ${new Date(live.deadlineAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""}
        </div>
      </div>
      <span className="live-step">{live.stepLabel}</span>
    </div>
  );
}

// 录用结果:标记通过/不通过 + 给候选人的说明;生成可复制的微信通知文案
function ResultCard({ candidate, onSaved, toast }: { candidate: any; onSaved: () => void | Promise<void>; toast: (m: string) => void }) {
  const [note, setNote] = useState(candidate.resultNote || "");
  const [busy, setBusy] = useState("");
  const result = candidate.result as "pass" | "reject" | undefined;
  const phone = candidate.phone as string | undefined;
  const smsReasonText: Record<string, string> = {
    no_phone: "候选人未填手机号,未发短信",
    sms_not_configured: "短信服务未配置,未发送(已保存结果)",
    template_missing: "短信模板未配置,未发送",
    bad_phone: "手机号格式不对,未发送",
  };
  const save = async (r: "pass" | "reject") => {
    setBusy(r);
    try {
      const res = await api.setResult(candidate.id, { result: r, note });
      const base = r === "pass" ? "已标记通过 · 候选人可在链接页看到" : "已标记不通过 · 候选人可在链接页看到";
      const sms = res.sms;
      if (sms?.sent) toast(base + " · 已发结果短信 ✅");
      else if (sms && sms.reason) toast(base + " · " + (smsReasonText[sms.reason] || "短信未发送:" + sms.reason));
      else toast(base);
      await onSaved();
    }
    catch (e) { toast("失败:" + (e as Error).message); }
    setBusy("");
  };
  const gen = async (r: "pass" | "reject") => {
    setBusy("gen-" + r);
    try { const res = await api.genResultReason(candidate.id, r); setNote(res.note || ""); toast("已结合评估生成,可再点「换一个」或自行修改"); }
    catch (e) { toast("生成失败:" + (e as Error).message); }
    setBusy("");
  };
  const copyNotify = () => {
    const txt = result === "pass"
      ? `你好 ${candidate.name},感谢参加${candidate.role ? ` ${candidate.role} 岗位` : ""}的面试。很高兴通知你:已通过本轮面试。${note ? "\n" + note : ""}`
      : `你好 ${candidate.name},感谢参加${candidate.role ? ` ${candidate.role} 岗位` : ""}的面试。经综合评估,本次暂不推进,期待未来有机会合作。${note ? "\n" + note : ""}`;
    copyText(txt).then((ok) => toast(ok ? "通知文案已复制,可粘贴到微信发给候选人" : "复制失败,请手动选中文案复制"));
  };
  const genBusy = busy.startsWith("gen-");
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="spread"><div className="section-h" style={{ marginTop: 0 }}>录用结果</div>
        {result && <span className={`rating ${result === "pass" ? "推荐" : "不推荐"}`}>{result === "pass" ? "已通过" : "未通过"}</span>}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>决定后,候选人打开自己的面试链接即可看到结果与下面的说明。说明可用 AI 结合评估生成、可反复换一个、也可自己改。</p>
      <p className="muted small" style={{ marginTop: 0 }}>
        手机号:{phone ? <b style={{ color: "var(--text, inherit)" }}>{phone}</b> : <span style={{ color: "#d05050" }}>未填(标记结果时不会发短信)</span>}
        {phone && " · 标记通过/不通过时自动发结果短信"}
      </p>
      <textarea style={{ minHeight: 84 }} placeholder="给候选人的说明 / 理由(通过或拒绝都会展示给他;可点下方「AI 生成」自动写,也可留空)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
        <button className="btn ghost sm" onClick={() => gen("reject")} disabled={!!busy}>{busy === "gen-reject" ? "生成中…" : note ? "✨ 换一个不通过理由" : "✨ AI 生成不通过理由"}</button>
        <button className="btn ghost sm" onClick={() => gen("pass")} disabled={!!busy}>{busy === "gen-pass" ? "生成中…" : "✨ 生成通过通知"}</button>
        {note && !genBusy && <button className="btn ghost sm" onClick={() => setNote("")}>清空</button>}
      </div>
      <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
        <button className="btn primary" onClick={() => save("pass")} disabled={!!busy}>{busy === "pass" ? "保存中…" : "标记通过"}</button>
        <button className="btn" onClick={() => save("reject")} disabled={!!busy} style={{ color: "#d05050" }}>{busy === "reject" ? "保存中…" : "标记不通过"}</button>
        {result && <button className="btn ghost" onClick={copyNotify}>复制通知文案</button>}
      </div>
    </div>
  );
}

// 初筛结论:一句话结论打头,详细依据折叠
function ScreeningCard({ screening }: { screening: any }) {
  const [showWhy, setShowWhy] = useState(false);
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="spread"><div className="section-h" style={{ marginTop: 0 }}>初筛结论</div><span className={`rating ${screening.rating}`}>{screening.rating}</span></div>
      <p style={{ fontSize: 14, lineHeight: 1.6, margin: "4px 0 8px" }}>{screening.summary || "（无结论)"}</p>
      {screening.risks?.length > 0 && (
        <div className="small gap" style={{ marginBottom: 6 }}>⚠ {screening.risks[0]}{screening.risks.length > 1 ? ` 等 ${screening.risks.length} 项` : ""}</div>
      )}
      {(screening.reasons?.length > 0 || screening.risks?.length > 1) && (
        <a className="small" onClick={() => setShowWhy(!showWhy)}>{showWhy ? "收起依据 ▲" : "查看依据与风险 ▼"}</a>
      )}
      {showWhy && (
        <div style={{ marginTop: 8 }}>
          {screening.reasons?.map((r: any, i: number) => (
            <div key={i} style={{ marginBottom: 8 }}><b className="small">{r.point}</b>{r.quote && <div className="quote small">{r.quote}</div>}</div>
          ))}
          {screening.risks?.length > 0 && <div style={{ marginTop: 4 }}><b className="small gap">风险</b>{screening.risks.map((r: string, i: number) => <div key={i} className="small gap">· {r}</div>)}</div>}
        </div>
      )}
    </div>
  );
}

// 社招资料收集面板:仅当该候选人有收集链接时显示;看进度、回看视频/截帧、删视频(留文字)
function CollectionPanel({ candidateId, toast }: { candidateId: string; toast: (m: string) => void }) {
  const [col, setCol] = useState<any>(null);
  const [busy, setBusy] = useState(""); // 当前进行中的操作标识:"" / "video"(删形象展示) / "eval"(报告) / "del:<qid>"(删某题视频)
  const load = () => api.collectionByCandidate(candidateId).then((r) => setCol(r.collection)).catch(() => undefined);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [candidateId]);
  if (!col) return null;
  const answered = col.questions ? col.questions.filter((q: any) => (col.answers || {})[q.id]).length : 0;
  const delVideo = async () => {
    if (!window.confirm("确定删除该候选人的录入视频吗?只删视频,文字回答和截帧照片都保留。")) return;
    setBusy("video");
    try { await api.deleteCollectionVideo(col.token); toast("视频已删除,文字与截帧保留"); await load(); }
    catch (e) { toast("删除失败:" + (e as Error).message); }
    setBusy("");
  };
  const openVideo = async () => {
    try { const r = await api.collectionVideoUrl(col.token); if (r.url) window.open(r.url, "_blank"); }
    catch (e) { toast("打开视频失败:" + (e as Error).message); }
  };
  const openAnswerVideo = async (qid: string) => {
    try { const r = await api.collectionAnswerVideoUrl(col.token, qid); if (r.url) window.open(r.url, "_blank"); }
    catch (e) { toast("打开该题视频失败:" + (e as Error).message); }
  };
  const delAnswerVideo = async (qid: string) => {
    if (!window.confirm("确定删除这一题的视频回答吗?只删该题视频,转写文字保留。")) return;
    setBusy("del:" + qid);
    try { await api.deleteCollectionAnswerVideo(col.token, qid); toast("该题视频已删除,文字保留"); await load(); }
    catch (e) { toast("删除失败:" + (e as Error).message); }
    setBusy("");
  };
  const evaluate = async () => {
    setBusy("eval");
    try { const r = await api.evaluateCollection(col.token); if (r.evaluation) setCol((c: any) => ({ ...c, evaluation: r.evaluation })); toast("面试报告已生成"); }
    catch (e) { toast("生成报告失败:" + (e as Error).message); }
    setBusy("");
  };
  const isAnchor = col.type === "anchor";
  const ev = col.evaluation;
  const answerVideos: string[] = col.answerVideos || [];
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="spread"><div className="section-h" style={{ marginTop: 0 }}>社招资料收集{isAnchor ? " · 主播岗" : ""}</div>
        <span className={`rating ${col.status === "done" ? "推荐" : "待定"}`}>{col.status === "done" ? "已提交" : "收集中"}</span>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>已答 {answered} / {col.questions?.length || 0} 题{isAnchor ? ` · 截帧 ${col.frames || 0} 张 · 视频回答 ${answerVideos.length} 段` : ""}{col.hasVideo ? " · 含形象展示视频" : ""}{isAnchor && col.pendingTranscripts > 0 ? ` · ${col.pendingTranscripts} 题转写中` : ""}</p>
      <div className="invite-box small">{location.origin}{col.url}</div>
      <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={() => copyText(`${location.origin}${col.url}`).then((ok) => toast(ok ? "链接已复制" : "复制失败"))}>复制收集链接</button>
        {col.hasVideo && <button className="btn sm" onClick={openVideo}>▶ 回看形象展示{col.videoStore === "cos" ? "(COS)" : ""}</button>}
        {col.hasVideo && <button className="btn sm" style={{ color: "var(--bad)", borderColor: "rgba(255,90,90,.4)" }} onClick={delVideo} disabled={busy === "video"}>{busy === "video" ? "删除中…" : "🗑 删形象展示"}</button>}
        {isAnchor && <button className="btn sm primary" onClick={evaluate} disabled={busy === "eval"}>{busy === "eval" ? "生成中…" : ev ? "重新生成面试报告" : "🎯 生成面试报告"}</button>}
      </div>

      {/* 逐题回答:每题的问题 + 回答转写 + 视频回看/删除(普通岗看文字,主播岗多视频) */}
      {(col.questions || []).length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="section-h" style={{ fontSize: 14, marginBottom: 6 }}>逐题回答({col.questions.length} 题)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {col.questions.map((q: any, i: number) => {
              const a = (col.answers || {})[q.id];
              const hasVid = answerVideos.includes(q.id);
              return (
                <div key={q.id || i} className="card2" style={{ padding: 12, borderRadius: 10 }}>
                  <div className="small" style={{ fontWeight: 600, lineHeight: 1.6 }}>
                    {q.category && <span className="noresp-badge" style={{ marginRight: 6, margin: 0 }}>{q.category}</span>}
                    {i + 1}. {q.q}
                  </div>
                  <div className="muted small" style={{ marginTop: 6, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                    {a ? a : <span style={{ fontStyle: "italic" }}>{hasVid ? "(视频已录,转写中或转写失败)" : "(未作答)"}</span>}
                  </div>
                  {hasVid && (
                    <div className="row" style={{ gap: 8, marginTop: 8 }}>
                      <button className="btn sm" onClick={() => openAnswerVideo(q.id)}>▶ 回看本题视频</button>
                      <button className="btn sm" style={{ color: "var(--bad)", borderColor: "rgba(255,90,90,.4)" }} onClick={() => delAnswerVideo(q.id)} disabled={busy === "del:" + q.id}>{busy === "del:" + q.id ? "删除中…" : "🗑 删本题视频"}</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isAnchor && ev && <AnchorEval ev={ev} />}
    </div>
  );
}

// 主播岗综合评定展示:5 维度评分条 + 综合结论 + 亮点/风险
function AnchorEval({ ev }: { ev: any }) {
  const recCls = ev.recommendation === "推荐" ? "推荐" : ev.recommendation === "不推荐" ? "不推荐" : "待定";
  const barColor = (s: number) => (s >= 80 ? "#4cae7a" : s >= 60 ? "#d4af37" : "#e2574c");
  return (
    <div className="card2" style={{ marginTop: 12, padding: 14, borderRadius: 12 }}>
      <div className="spread" style={{ alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontWeight: 700 }}>主播面试报告 · 综合分 <span style={{ color: "var(--gold)", fontSize: 18 }}>{ev.overall}</span> · {ev.level}</div>
        <span className={`rating ${recCls}`}>{ev.recommendation}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7, margin: "8px 0" }}>
        {(ev.dims || []).map((d: any, i: number) => (
          <div key={i}>
            <div className="spread" style={{ fontSize: 13 }}><span>{d.name}</span><span style={{ color: barColor(d.score), fontWeight: 700 }}>{d.score}</span></div>
            <div style={{ height: 5, background: "var(--border)", borderRadius: 999, overflow: "hidden", margin: "3px 0 2px" }}>
              <div style={{ height: "100%", width: `${d.score}%`, background: barColor(d.score) }} />
            </div>
            {d.comment && <div className="muted small">{d.comment}</div>}
          </div>
        ))}
      </div>
      {ev.summary && <p className="small" style={{ lineHeight: 1.7, margin: "8px 0" }}>{ev.summary}</p>}
      {(ev.highlights || []).length > 0 && <div className="small" style={{ marginTop: 6 }}><b style={{ color: "var(--ok, #4cae7a)" }}>亮点:</b><ul style={{ margin: "4px 0", paddingLeft: 18 }}>{ev.highlights.map((h: string, i: number) => <li key={i}>{h}</li>)}</ul></div>}
      {(ev.risks || []).length > 0 && <div className="small"><b style={{ color: "var(--bad, #e2574c)" }}>风险/存疑:</b><ul style={{ margin: "4px 0", paddingLeft: 18 }}>{ev.risks.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></div>}
    </div>
  );
}

// 简历:把 BOSS 同步的「【标签】内容」段落(以及旧「标签:内容」字段)解析成带小标题的清爽版块,
// 而不是一坨连在一起的纯文本。长段落按编号项/句号软分行,提升可读性。
const KNOWN_LABELS = ["基础信息", "求职意向", "工作经历", "项目经历", "项目", "教育经历", "技能工具", "技能", "工具", "作品", "链接", "联系方式", "薪资", "地点", "到岗", "沟通状态", "下一步", "期望", "自我评价"];

// 把一段长内容拆成多行:在中文句末标点(。;；!?)后断行,使长段落/分号连写(技能、教育、freeform 经历)逐句可读。
// 只认全角句末标点,故不会误切小数(10.5)、顿号连写(5、6月)、日期(2023-2026)。
function splitContent(s: string): string[] {
  return s
    .replace(/([。；;！？])\s*(?=\S)/g, "$1\n")
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ── 工作/项目经历:把每个条目拆成 标题 / 时间段 / 角色 / 描述 / 技术栈 / 职责 ──
type ExpEntry = { title: string; role: string; period: string; desc: string; tech: string; duties: string[] };

function isExperience(label: string): boolean {
  return label.endsWith("项目") || /(工作|项目|实习|实践)经历|项目经验/.test(label) || label === "实习";
}

// 在「句末标点 + 编号(1. / 2、)」处拆成多个条目;无编号则整段一条
function splitEntries(content: string): string[] {
  return content.split(/(?<=[。；])\s*(?=\d{1,2}[.、]\s)/).map((s) => s.trim()).filter(Boolean);
}

function splitHeader(header: string): { title: string; role: string[]; period: string } {
  const segs = header.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
  let title = "", period = "";
  const role: string[] = [];
  for (const seg of segs) {
    if (/(\d{4}\s*[.\-/年]\s*\d{1,2})|至今|长期/.test(seg)) period = period ? period + " " + seg : seg;
    else if (!title) title = seg;
    else role.push(seg);
  }
  return { title, role, period };
}

function parseExpEntry(raw: string): ExpEntry {
  const s = raw.replace(/^\s*\d{1,2}[.、]\s*/, "").trim();
  const ci = s.search(/[：:]/);
  let header = (ci >= 0 ? s.slice(0, ci) : s).trim();
  let body = ci >= 0 ? s.slice(ci + 1).trim() : "";
  let h = splitHeader(header);
  // 双冒号结构「项目名:子标题,角色,时间:描述」—— header 没解析出时间而 body 前段含时间,则并入 header 重解析
  if (!h.period && body) {
    const ci2 = body.search(/[：:]/);
    if (ci2 >= 0 && ci2 < 60 && /(\d{4}[.\-/年]\d{1,2})|至今/.test(body.slice(0, ci2))) {
      header = header + "，" + body.slice(0, ci2);
      body = body.slice(ci2 + 1).trim();
      h = splitHeader(header);
    }
  }
  let tech = "", desc = body;
  let duties: string[] = [];
  const techM = body.match(/技术栈[:：]?\s*([^。]+)。?/);
  const dutyM = body.match(/职责(?:包括|涵盖|包含|主要)?[:：]?\s*([\s\S]+)$/);
  if (techM) tech = techM[1].trim();
  if (dutyM) duties = dutyM[1].split(/[；;]/).map((x) => x.replace(/[。\s]+$/, "").trim()).filter(Boolean);
  if (techM) desc = body.slice(0, techM.index).trim();
  else if (dutyM) desc = body.slice(0, dutyM!.index).trim();
  return { title: h.title, role: h.role.join(" · "), period: h.period, desc, tech, duties };
}

function ExperienceView({ content }: { content: string }) {
  const entries = splitEntries(content).map(parseExpEntry);
  // 仅当每个条目都「干净」(标题不过长 + 有时间段/技术栈/职责之一)才用卡片;
  // freeform 经历(无编号、时间在括号、用分号连写)会解析不干净 → 降级为按句分行,仍可读。
  const allClean = entries.length >= 1 && entries.every((e) => e.title && e.title.length <= 28 && (e.period || e.tech || e.duties.length > 0));
  if (!allClean) return <div className="resume-sec-body">{splitContent(content).map((p, j) => <p className="resume-line" key={j}>{p}</p>)}</div>;
  return (
    <div className="exp-list">
      {entries.map((e, i) => (
        <div className="exp-item" key={i}>
          <div className="exp-head">
            <span className="exp-title">{e.title || `条目 ${i + 1}`}</span>
            {e.period && <span className="exp-period">{e.period}</span>}
          </div>
          {e.role && <div className="exp-role">{e.role}</div>}
          {e.desc && <div className="exp-desc">{splitContent(e.desc).map((p, j) => <p className="exp-line" key={j}>{p}</p>)}</div>}
          {e.tech && <div className="exp-meta"><span className="exp-tag">技术栈</span><span className="exp-tech-text">{e.tech}</span></div>}
          {e.duties.length > 0 && (
            <div className="exp-meta"><span className="exp-tag">职责</span><ul className="exp-duties">{e.duties.map((d, j) => <li key={j}>{d}</li>)}</ul></div>
          )}
        </div>
      ))}
    </div>
  );
}

// 「未回应人才库」等来源的简历常把所有信息塞进一大段,用内嵌中文标签「基础信息:教育:实习经历:核心项目:技能:匹配判断:」分隔。
// 识别这些内嵌标签,把长段切成带小标题的版块,大幅改善"一坨"的可读性。
const INLINE_LABELS = ["基础信息", "基本信息", "个人信息", "教育背景", "教育经历", "工作经历", "工作经验", "实习经历", "实习经验", "项目经历", "项目经验", "核心项目", "重点项目", "主要项目", "代表项目", "其他项目", "自我介绍", "自我描述", "个人优势", "个人评价", "能力概览", "专业方向/技能", "专业方向", "专业技能", "技能工具", "求职意向", "求职意愿", "匹配判断", "推荐理由", "综合评价", "综合评估", "BOSS操作", "关键信号", "下一步动作", "教育", "证书", "荣誉", "获奖", "技能", "期望"];
const INLINE_RE = new RegExp(`(?<=[。；;！？\\n、，,/\\s]|^)(${INLINE_LABELS.join("|")})(?:[：:]|(?=包括|包含))`, "g");

function inlineSplit(text: string): Array<{ label: string | null; body: string }> {
  const segs: Array<{ label: string | null; body: string }> = [];
  let last = 0, lastLabel: string | null = null, m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    segs.push({ label: lastLabel, body: text.slice(last, m.index).trim() });
    lastLabel = m[1];
    last = INLINE_RE.lastIndex;
  }
  segs.push({ label: lastLabel, body: text.slice(last).trim() });
  return segs.filter((s) => s.body || s.label);
}

// 把一大段(可能含内嵌标签)渲染成版块:有标签→小标题+正文(经历类走 ExperienceView),无标签开头→按句分行
function renderInlineLabeled(text: string, key: string) {
  const segs = inlineSplit(text);
  return segs.map((s, i) => {
    const body = s.body.replace(/^(?:包括|包含|涉及)?[：:，,]?\s*/, "").trim();
    if (!s.label) {
      if (!body) return null;
      return <React.Fragment key={`${key}-${i}`}>{splitContent(body).map((p, j) => <p className="resume-p" key={j}>{p}</p>)}</React.Fragment>;
    }
    return (
      <div className="resume-sec" key={`${key}-${i}`}>
        <div className="resume-sec-h">{s.label}</div>
        {body && (isExperience(s.label)
          ? <ExperienceView content={body} />
          : <div className="resume-sec-body">{splitContent(body).map((p, j) => <p className="resume-line" key={j}>{p}</p>)}</div>)}
      </div>
    );
  });
}

// 单行解析:短「标签:值」→字段;超长行→按内嵌标签/句子排版;其余→段落
function renderPlainLines(block: string, key: string) {
  return block.split(/\n+/).map((line, j) => {
    const t = line.trim();
    if (!t) return null;
    if (t.length > 60) return <React.Fragment key={`${key}-${j}`}>{renderInlineLabeled(t, `${key}-${j}`)}</React.Fragment>;
    const fld = t.match(/^([^:：]{1,14})[：:]\s*(.*)$/);
    if (fld && (KNOWN_LABELS.some((k) => fld[1].includes(k)) || fld[1].length <= 6)) {
      return <div className="resume-field" key={`${key}-${j}`}><div className="resume-k">{fld[1]}</div><div className="resume-v">{fld[2] || "—"}</div></div>;
    }
    return <p className="resume-p" key={`${key}-${j}`}>{t}</p>;
  });
}

function ResumeView({ text }: { text: string }) {
  const raw = (text || "").trim();
  if (!raw) return <p className="muted small">(无简历文本)</p>;
  // 先按【标签】出现处切块:这样「标签与正文跨行」的 section(如【工作经历】换行后跟 1./2.)正文仍归属同一块,不会脱离小标题
  const blocks = raw.split(/\n(?=\s*【)/).map((b) => b.trim()).filter(Boolean);
  return (
    <div className="resume">
      {blocks.map((block, i) => {
        const sec = block.match(/^【(.+?)】([\s\S]*)$/);
        if (sec) {
          const label = sec[1].trim();
          const content = sec[2].trim();
          return (
            <div className="resume-sec" key={i}>
              <div className="resume-sec-h">{label}</div>
              {content && (
                isExperience(label)
                  ? <ExperienceView content={content} />
                  : <div className="resume-sec-body">
                      {splitContent(content).map((p, j) => <p className="resume-line" key={j}>{p}</p>)}
                    </div>
              )}
            </div>
          );
        }
        // 非【】块(第一个【标签】之前的内容,或旧「标签:内容」格式)
        return <React.Fragment key={i}>{renderPlainLines(block, String(i))}</React.Fragment>;
      })}
    </div>
  );
}

// 候选人所在地(现居 / 期望)展示 + 后台可改
function LocationRow({ candidate, onSaved, toast }: { candidate: any; onSaved: () => void | Promise<void>; toast: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [cur, setCur] = useState(candidate.locationCurrent || "");
  const [exp, setExp] = useState(candidate.locationExpect || "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (editing) return; setCur(candidate.locationCurrent || ""); setExp(candidate.locationExpect || ""); }, [candidate.locationCurrent, candidate.locationExpect, editing]);
  const save = async () => {
    setBusy(true);
    try { await api.setLocation(candidate.id, { current: cur.trim(), expect: exp.trim() }); toast("所在地已更新"); setEditing(false); await onSaved(); }
    catch (e) { toast("保存失败:" + (e as Error).message); }
    setBusy(false);
  };
  const cancel = () => { setEditing(false); setCur(candidate.locationCurrent || ""); setExp(candidate.locationExpect || ""); };
  return (
    <div className="loc-row">
      {!editing ? (
        <>
          <span className="loc-item"><span className="loc-label">现居</span>{candidate.locationCurrent || <span className="loc-empty">未知</span>}</span>
          <span className="loc-item"><span className="loc-label">期望</span>{candidate.locationExpect || <span className="loc-empty">未知</span>}</span>
          {candidate.isLocal && <span className="local-badge" title="徐州本地(按简历判定:期望/现居/上学地)">📍徐州本地</span>}
          <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setEditing(true)}>编辑</button>
        </>
      ) : (
        <>
          <label className="loc-field"><span className="loc-label">现居</span><input value={cur} onChange={(e) => setCur(e.target.value)} placeholder="目前所在城市" /></label>
          <label className="loc-field"><span className="loc-label">期望</span><input value={exp} onChange={(e) => setExp(e.target.value)} placeholder="期望工作城市" /></label>
          <button className="btn primary sm" onClick={save} disabled={busy}>{busy ? "保存中…" : "保存"}</button>
          <button className="btn ghost sm" onClick={cancel} disabled={busy}>取消</button>
        </>
      )}
    </div>
  );
}

// 邀约链接随时可复制 —— token 存在库里,不怕弄丢
function InviteLink({ interview, toast }: { interview: any; toast: (m: string) => void }) {
  const token = interview.candidateLinkToken;
  if (!token) return <span className="muted small">已发起面试(无邀约 token)· 状态 {interview.status}</span>;
  const url = `${location.origin}/p/interview/${token}`;
  const expired = interview.inviteExpiresAt && new Date(interview.inviteExpiresAt).getTime() < Date.now();
  return (
    <div>
      <div className="row small" style={{ marginBottom: 6 }}>
        <span className="muted">状态 {interview.status}</span>
        {interview.inviteExpiresAt && <span className={expired ? "bad" : "muted"}>· {expired ? "已过期" : "截止"} {interview.inviteExpiresAt.slice(5, 16).replace("T", " ")}</span>}
      </div>
      <div className="invite-box small">{url}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => copyText(url).then((ok) => toast(ok ? "链接已复制" : "复制失败,请手动复制下面的链接"))}>复制链接</button>
        <a className="small" href={url} target="_blank" rel="noreferrer">在新窗口打开</a>
      </div>
      {expired && <p className="warn small" style={{ marginTop: 6 }}>链接已过期,需重新「发起 AI 面试」生成新链接。</p>}
    </div>
  );
}

function TL({ state, title, body }: { state: "done" | "wait" | "todo"; title: string; body: React.ReactNode }) {
  return (
    <div className="tl-item">
      <div className={`tl-dot ${state}`} />
      <div className="tl-title">{title}</div>
      <div className="tl-body">{body}</div>
    </div>
  );
}

function QuestionList({ interview }: { interview: any }) {
  // 点题目 -> 弹窗查看回答(整理稿/转写/评判),不在窄列里内联展开(避免内容挤在列里、看着像跑到上面)
  const [openQ, setOpenQ] = useState<any>(null);
  const list: any[] = interview.questions || [];
  return (
    <div style={{ marginTop: 6 }}>
      {list.map((q: any, i: number) => (
        <div className="qa qa-clickable" key={q.questionId} onClick={() => setOpenQ(q)}>
          <div className="spread">
            <span className="q" style={{ marginBottom: 0 }}>{i + 1}. {q.originalQuestion}</span>
            <span className="row" style={{ gap: 8, flexShrink: 0 }}>
              {q.audioBackup && !(q.correctedTranscript || "").trim() && <span className="grade C" title="录音已收到但转写失败、录音已备份,可在上方「重转失败题」恢复文字">⚠ 转写失败</span>}
              {q.judge?.grade && <span className={`grade ${q.judge.grade}`}>{q.judge.grade}</span>}
              <span className="muted small">查看回答 →</span>
            </span>
          </div>
        </div>
      ))}
      {openQ && <QuestionModal q={openQ} onClose={() => setOpenQ(null)} />}
    </div>
  );
}

function QuestionModal({ q, onClose }: { q: any; onClose: () => void }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>面试回答{q.dimension ? ` · ${q.dimension}` : ""}</h2>
          {q.judge?.grade && <span className={`grade ${q.judge.grade}`}>{q.judge.grade}{q.judge.score ? `(${q.judge.score})` : ""}</span>}
        </div>
        <p className="q" style={{ marginTop: 0 }}>{q.originalQuestion}</p>
        {q.answerSummary && (
          <div className="answer-summary">
            <div className="small"><b>🧠 AI 整理(逻辑重排 · 改错字 · 小结)</b></div>
            <div className="small" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{q.answerSummary}</div>
          </div>
        )}
        <div className="muted small">回答转写(原始)</div>
        <div className="small" style={{ whiteSpace: "pre-wrap", margin: "4px 0 12px" }}>
          {(q.correctedTranscript || "").trim()
            ? q.correctedTranscript
            : q.audioBackup
              ? <span className="warn">⚠ 录音已收到,但转写失败(账号/服务异常)。录音已备份——请在面试区点「🔄 重转失败题」恢复文字,或让候选人重答。</span>
              : q.audioReceived
                ? <span className="warn">⚠ 录音已收到但没有转写文字(可能候选人未出声,或转写失败且当时未备份录音,只能让其重答)。</span>
                : "（候选人未作答）"}
        </div>
        {q.judge && (
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
            <div className="small"><b>评判</b> {q.judge.grade}（{q.judge.score}）· {q.judge.summary}</div>
            {q.judge.quotes?.map((quote: string, i: number) => <div key={i} className="quote small">{quote}</div>)}
            {q.judge.gaps?.map((g: string, i: number) => <div key={i} className="small gap">未讲清:{g}</div>)}
          </div>
        )}
        {q.followUpQuestion && <div className="small" style={{ marginTop: 8 }}><b>自动追问</b>:{q.followUpQuestion}</div>}
        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function ReportView({ e }: { e: any }) {
  const r = e.raw || {};
  return (
    <div className="card" style={{ marginTop: 6 }}>
      <div className="spread"><b>{e.summary}</b><span className={`rating ${e.recommendation}`}>{e.recommendation}</span></div>
      {r.answersOverview && (
        <div className="answer-summary" style={{ marginTop: 8 }}>
          <div className="small"><b>🧠 回答整体总结</b></div>
          <div className="small" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{r.answersOverview}</div>
        </div>
      )}
      {r.teachingIp && <div className="small" style={{ marginTop: 8 }}><b>🎬 教学 / IP 潜质</b>:{r.teachingIp}</div>}
      {r.strengths?.length > 0 && <div style={{ marginTop: 8 }}><b className="small ok">亮点</b>{r.strengths.map((s: string, i: number) => <div key={i} className="small">+ {s}</div>)}</div>}
      {r.concerns?.length > 0 && <div style={{ marginTop: 6 }}><b className="small gap">存疑</b>{r.concerns.map((s: string, i: number) => <div key={i} className="small gap">- {s}</div>)}</div>}
      {(e.reviewChecklist || []).length > 0 && (
        <div style={{ marginTop: 8 }}><b className="small">二面复核清单</b>
          {e.reviewChecklist.map((c: any, i: number) => <div key={i} className="small" style={{ marginTop: 4 }}>{i + 1}. {c.point}<div className="muted small">→ {c.why}</div></div>)}
        </div>
      )}
    </div>
  );
}

function QuestionRow({ q, index, candidateId, onChange, onDelete }: { q: any; index: number; candidateId: string; onChange: (t: string) => void; onDelete: () => void }) {
  const [steer, setSteer] = useState("");
  const [busy, setBusy] = useState(false);
  const regen = async () => {
    if (!steer.trim()) return;
    setBusy(true);
    try {
      const r = await api.regenerateQuestion(candidateId, { dimension: q.dimension, currentQuestion: q.originalQuestion, steer });
      onChange(r.question);
      setSteer("");
    } catch (e) { alert("改写失败:" + (e as Error).message); }
    setBusy(false);
  };
  return (
    <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
      <div className="spread"><label style={{ margin: 0 }}>第 {index + 1} 题 · {q.dimension}</label>
        <a className="small bad" onClick={onDelete}>删除</a>
      </div>
      <textarea value={q.originalQuestion} onChange={(e) => onChange(e.target.value)} placeholder="题目内容…" />
      <div className="row" style={{ marginTop: 6 }}>
        <input className="small" style={{ flex: 1 }} placeholder="不满意?输入调整方向,例如「更聚焦工程落地细节」" value={steer} onChange={(e) => setSteer(e.target.value)} onKeyDown={(e) => e.key === "Enter" && regen()} />
        <button className="btn sm" onClick={regen} disabled={busy || !steer.trim()}>{busy ? "改写中…" : "AI 改写"}</button>
      </div>
    </div>
  );
}

// 配额行:一个维度 + 题数(可加减)。专业技术维度高亮成"技术性问题"。
function SpecRow({ row, isTech, onN }: { row: { key: string; name: string; weight: number; n: number }; isTech: boolean; onN: (n: number) => void }) {
  return (
    <div className="qspec-row">
      <div className="qspec-name">
        {row.name}{isTech && <span className="qspec-tech">技术性问题</span>}
        <span className="muted small" style={{ marginLeft: 8 }}>权重 {row.weight}%</span>
      </div>
      <div className="qspec-stepper">
        <button className="btn sm" onClick={() => onN(Math.max(0, row.n - 1))} disabled={row.n <= 0}>−</button>
        <input className="qspec-num" type="number" min={0} value={row.n}
          onChange={(e) => onN(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
        <button className="btn sm" onClick={() => onN(row.n + 1)}>+</button>
      </div>
    </div>
  );
}

function LaunchModal({ candidate, screening, onClose, onLaunched }: { candidate: any; screening: any; onClose: () => void; onLaunched: () => void }) {
  // step: spec(配额表单) -> review(确认/编辑题目) -> invite(链接)
  const [step, setStep] = useState<"spec" | "review">("spec");
  const [plan, setPlan] = useState<{ positionRole: string; dimensions: Array<{ key: string; name: string; weight: number }>; suggested: { total: number; counts: Array<{ key: string; name: string; weight: number; n: number }> } } | null>(null);
  const [rows, setRows] = useState<Array<{ key: string; name: string; weight: number; n: number }>>([]);
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState("");

  const [questions, setQuestions] = useState<any[]>([]);
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 进入弹窗即拉取该候选人岗位维度 + 按权重的建议配额
  useEffect(() => {
    let alive = true;
    api.questionPlan(candidate.id)
      .then((p) => { if (!alive) return; setPlan(p); setRows(p.suggested.counts.map((c) => ({ ...c }))); })
      .catch((e) => { if (alive) setGenErr("加载岗位维度失败:" + (e as Error).message); });
    return () => { alive = false; };
  }, [candidate.id]);

  const total = rows.reduce((s, r) => s + r.n, 0);
  const techRow = rows.find((r) => r.key === "tech");

  // 按权重把指定总数重新分配到各维度
  const redistribute = (t: number) => {
    if (!plan) return;
    const dims = plan.dimensions;
    const totalW = dims.reduce((s, d) => s + (d.weight || 0), 0) || 1;
    const tmp = dims.map((d) => { const ex = (t * (d.weight || 0)) / totalW; return { key: d.key, name: d.name, weight: d.weight || 0, n: Math.floor(ex), frac: ex - Math.floor(ex) }; });
    let assigned = tmp.reduce((s, r) => s + r.n, 0);
    const order = [...tmp].sort((a, b) => b.frac - a.frac || b.weight - a.weight);
    let i = 0;
    while (assigned < t && order.length) { order[i % order.length].n++; assigned++; i++; }
    setRows(tmp.map(({ key, name, weight, n }) => ({ key, name, weight, n })));
  };

  const generate = async () => {
    setGenBusy(true); setGenErr("");
    try {
      const r = await api.generateQuestions(candidate.id, { counts: rows.map((x) => ({ key: x.key, dimension: x.name, n: x.n })) });
      setQuestions(r.questions.map((q: any, i: number) => ({ questionId: q.questionId || `q${i + 1}`, dimension: q.dimension, originalQuestion: q.question })));
      setStep("review");
    } catch (e) { setGenErr("出题失败:" + (e as Error).message); }
    setGenBusy(false);
  };

  const launch = async () => {
    setBusy(true);
    try {
      const r = await api.createInterview({
        candidateId: candidate.id, candidateName: candidate.name, candidateRole: candidate.role,
        feishuRecordId: candidate.feishuRecordId,
        questions: questions.map((q, i) => ({ questionId: q.questionId, ord: i, dimension: q.dimension, originalQuestion: q.originalQuestion })),
      });
      setInvite({ url: location.origin + r.inviteUrl, expiresAt: r.inviteExpiresAt });
    } catch (e) { alert("发起失败:" + (e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {invite ? (
          <>
            <h2 style={{ marginTop: 0 }}>邀约链接已生成</h2>
            <p className="muted small">把下面链接通过微信发给候选人,48 小时内有效(截止 {invite.expiresAt.slice(0, 16).replace("T", " ")})。</p>
            <div className="invite-box">{invite.url}</div>
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn primary" onClick={() => copyText(invite.url).then((ok) => alert(ok ? "链接已复制,可粘贴发给候选人" : "复制失败,请手动复制上面的链接"))}>复制链接</button>
              <button className="btn" onClick={onLaunched}>完成</button>
            </div>
          </>
        ) : step === "spec" ? (
          <>
            <div className="spread">
              <h2 style={{ marginTop: 0 }}>发起 AI 面试 · {candidate.name}</h2>
              {plan && <span className="muted small">{plan.positionRole}</span>}
            </div>
            <p className="muted small">先定这场面试的题目结构:总题数、其中技术性问题几道、其余各维度各几道。确定后 AI 结合本人简历按配额定制出题。</p>
            {!plan ? (
              <p className="muted small">{genErr || "加载岗位维度…"}</p>
            ) : (
              <>
                <div className="qspec-total">
                  <span>题目总数</span>
                  <div className="qspec-stepper">
                    <button className="btn sm" onClick={() => redistribute(Math.max(1, total - 1))} disabled={total <= 1}>−</button>
                    <input className="qspec-num" type="number" min={1} value={total} onChange={(e) => redistribute(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
                    <button className="btn sm" onClick={() => redistribute(total + 1)}>+</button>
                  </div>
                </div>
                <p className="muted small" style={{ margin: "2px 0 10px" }}>改总数会按岗位权重自动分配到各维度,你也可以逐项手动调整(下面合计即实际总数)。</p>
                <div className="qspec-list">
                  {rows.map((row, i) => (
                    <SpecRow key={row.key} row={row} isTech={row.key === "tech"}
                      onN={(n) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, n } : x))} />
                  ))}
                </div>
                <div className="qspec-summary">
                  合计 <b>{total}</b> 道{techRow ? <> · 技术性 <b>{techRow.n}</b> 道 · 其他 <b>{total - techRow.n}</b> 道</> : null}
                </div>
                {genErr && <p className="warn small">{genErr}</p>}
                {genBusy && <p className="muted small" style={{ margin: "8px 0 0" }}>AI 正在结合简历逐维度定制 {total} 道题,通常 10 秒左右,请耐心等待,不要关闭…</p>}
                <div className="row" style={{ marginTop: 16 }}>
                  <button className="btn primary" onClick={generate} disabled={genBusy || total < 1}>{genBusy ? `AI 出题中…(${total} 道)` : `按配额出题(${total} 道)`}</button>
                  <button className="btn ghost" onClick={onClose} disabled={genBusy}>取消</button>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="spread">
              <h2 style={{ marginTop: 0 }}>确认题目 · {candidate.name}</h2>
              <span className="muted small">{questions.length} 道题</span>
            </div>
            <p className="muted small">确认/编辑/增删题目;不满意可输入方向让 AI 改写。生成 48h 邀约链接发给候选人。</p>
            {questions.map((q, i) => (
              <QuestionRow key={q.questionId} q={q} index={i} candidateId={candidate.id}
                onChange={(text) => setQuestions((qs) => qs.map((x, j) => j === i ? { ...x, originalQuestion: text } : x))}
                onDelete={() => setQuestions((qs) => qs.filter((_, j) => j !== i))} />
            ))}
            <button className="btn ghost sm" style={{ marginTop: 4 }}
              onClick={() => setQuestions((qs) => [...qs, { questionId: `q-new-${Date.now()}`, dimension: "自定义", originalQuestion: "" }])}>
              + 添加一道题
            </button>
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn ghost" onClick={() => setStep("spec")} disabled={busy}>← 重新配置</button>
              <button className="btn primary" onClick={launch} disabled={busy || questions.length === 0}>{busy ? "生成中…" : "生成邀约链接"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ───────── 分享链接:把候选人完整档案生成只读链接发给 HR/他人,可设查看次数与有效期 ─────────
function ShareModal({ candidate, toast, onClose }: { candidate: any; toast: (m: string) => void; onClose: () => void }) {
  const [links, setLinks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [maxViews, setMaxViews] = useState("");       // 空 = 不限次数
  const [validHours, setValidHours] = useState("168"); // 默认 7 天
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try { const r = await api.shareLinks(candidate.id); setLinks(r.links || []); } catch { /* ignore */ }
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const fullUrl = (u: string) => location.origin + u;

  const create = async () => {
    setBusy(true);
    try {
      const mv = maxViews.trim() ? Math.max(1, Math.round(Number(maxViews))) : null;
      const vh = validHours ? Number(validHours) : null;
      const r = await api.createShareLink(candidate.id, { maxViews: mv, validHours: vh, note: note.trim() || undefined });
      const okCopy = await copyText(fullUrl(r.link.url));
      toast(okCopy ? "分享链接已生成并复制,可直接粘贴发送" : "分享链接已生成(复制失败,请在下方手动复制)");
      setNote("");
      await load();
    } catch (e) { toast("生成失败:" + (e as Error).message); }
    setBusy(false);
  };

  const revoke = async (token: string) => {
    if (!window.confirm("撤销后此链接立即失效,已发出去的链接将无法再打开。确定?")) return;
    try { await api.revokeShareLink(token); toast("已撤销"); await load(); } catch (e) { toast("撤销失败:" + (e as Error).message); }
  };

  const copyOne = async (u: string) => { const okCopy = await copyText(fullUrl(u)); toast(okCopy ? "链接已复制" : "复制失败,请手动复制"); };

  const STATUS_TEXT: Record<string, string> = { active: "有效", revoked: "已撤销", expired: "已过期", exhausted: "已达次数上限" };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>分享 {candidate.name} 的面试档案</h2>
        <p className="muted small">生成只读链接发给 HR 或他人,对方<b>无需登录</b>即可查看该候选人的<b>个人资料、沟通记录、面试情况与评价、整体评估与反馈</b>。可设查看次数和有效期,到期或超次数自动失效。</p>

        <div className="share-form">
          <div className="share-field">
            <label>查看次数上限</label>
            <input className="picker-input" type="number" min={1} inputMode="numeric" placeholder="不限" value={maxViews}
              onChange={(e) => setMaxViews(e.target.value.replace(/\D/g, ""))} />
            <span className="muted small">留空 = 不限;填 2 = 对方打开查看 2 次后失效</span>
          </div>
          <div className="share-field">
            <label>有效期</label>
            <select className="picker-input" value={validHours} onChange={(e) => setValidHours(e.target.value)}>
              <option value="">不限</option>
              <option value="24">1 天</option>
              <option value="72">3 天</option>
              <option value="168">7 天</option>
              <option value="720">30 天</option>
            </select>
            <span className="muted small">到期后链接自动失效</span>
          </div>
          <div className="share-field">
            <label>备注(仅自己可见)</label>
            <input className="picker-input" type="text" placeholder="如:发给市场部王经理" value={note} maxLength={100}
              onChange={(e) => setNote(e.target.value)} />
          </div>
          <button className="btn primary" onClick={create} disabled={busy}>{busy ? "生成中…" : "生成并复制链接"}</button>
        </div>

        <div className="section-h">已生成的链接</div>
        {loading ? <p className="muted small">加载中…</p> : links.length === 0 ? <p className="muted small">还没有分享链接。</p> : (
          <div className="share-list">
            {links.map((l) => (
              <div key={l.token} className={"share-row" + (l.status !== "active" ? " dead" : "")}>
                <div className="share-row-main">
                  <span className={"share-badge " + l.status}>{STATUS_TEXT[l.status] || l.status}</span>
                  <code className="share-url">{fullUrl(l.url)}</code>
                </div>
                <div className="share-row-meta muted small">
                  已查看 {l.viewCount}{l.maxViews != null ? ` / ${l.maxViews} 次` : " 次(不限)"}
                  {l.validUntil ? ` · 到期 ${l.validUntil.slice(0, 16).replace("T", " ")}` : " · 不限期"}
                  {l.note ? ` · ${l.note}` : ""}
                </div>
                <div className="share-row-act">
                  <button className="btn ghost sm" onClick={() => copyOne(l.url)}>复制</button>
                  {l.status === "active" && <button className="btn ghost sm" onClick={() => revoke(l.token)} style={{ color: "var(--bad)" }}>撤销</button>}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
