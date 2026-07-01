// 职位综合排名:按职位看在库人员排名,「已面试」与「未面试」分两组。
// - 未面试组:只按 AI 初筛评级(推荐/待定/不推荐)排 —— 不用飞书同步带来的 priority(那不是统一标准)。
// - 已面试组:默认按"录用>面试评级"排;可点「AI 综合重排」用 compareCandidates 从 简历/回答/综合素质 三维度综合打分排序。
// 已淘汰(result=reject,在「不通过库」)不参与排名。
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { stageMeta } from "../stages.js";

const GRADE: Record<string, number> = { "A": 90, "A-": 85, "B+": 80, "B": 75, "C+": 70, "C": 60, "D": 40 };
const SCREEN: Record<string, number> = { "推荐": 50, "待定": 30, "不推荐": 10 };
// 已面试组:已录用最高,其次按面试评级
const interviewScore = (c: any): number => (c.result === "pass" ? 100 : (GRADE[c.priority] ?? 0));
// 未面试组:只看 AI 初筛评级(忽略飞书带的 priority)
const screenScore = (c: any): number => (SCREEN[c.screeningRating] ?? 0);
// 「面试过」= 已出一面报告/结论的阶段(reviewed 及之后)。priority 字段被飞书广泛填充,不能用它判断。
const POST_INTERVIEW = new Set(["reviewed", "second_invited", "second_picked", "second_confirmed", "result"]);
const isInterviewed = (c: any) => POST_INTERVIEW.has(c.currentStage);
const byNameZh = (a: any, b: any) => String(a.name).localeCompare(String(b.name), "zh");

// AI 综合排名结果按 职位+组(iv 已面试 / nt 未面试)缓存到 localStorage,刷新/重开后仍能看到
const aiKey = (pos: string, grp: string) => `rank.ai.${pos}.${grp}`;
function loadAi(pos: string, grp: string): { map: Record<string, any>; summary: string } | null {
  try { const r = localStorage.getItem(aiKey(pos, grp)); return r ? JSON.parse(r) : null; } catch { return null; }
}

// screenOnly:未面试组只展示初筛评级,不展示飞书 priority
function RatingBadge({ c, screenOnly }: { c: any; screenOnly?: boolean }) {
  if (c.result === "pass") return <span className="rating 推荐">已通过</span>;
  if (!screenOnly && c.priority) return <span className="grade B">{c.priority}</span>;
  if (c.screeningRating) return <span className={`rating ${c.screeningRating}`}>{c.screeningRating}<span className="muted small" style={{ marginLeft: 4 }}>初筛</span></span>;
  return <span className="muted small">待评</span>;
}

function RankRow({ c, i, ai, screenOnly, onOpen }: { c: any; i: number; ai?: any; screenOnly?: boolean; onOpen: (id: string) => void }) {
  const m = stageMeta(c.currentStage);
  const edu = [c.eduSchoolName, c.eduDegree].filter(Boolean).join(" · ");
  return (
    <div className="rank-item" onClick={() => onOpen(c.id)}>
      <div className="rank-row">
        <span className={"rank-no" + (i < 3 ? " top" + (i + 1) : "")}>{i + 1}</span>
        <b className="rank-name">{c.name}</b>
        {c.isLocal && <span className="local-badge" title="期望/现居徐州">📍徐州</span>}
        <span className="muted small rank-edu">{edu}</span>
        {ai && <span className="rank-ai">综合 <b>{ai.score}</b></span>}
        <span style={{ marginLeft: "auto" }} className="row"><RatingBadge c={c} screenOnly={screenOnly} /></span>
        <span className="rank-stage"><span className="stage-dot" style={{ background: m.color }} />{m.label}</span>
      </div>
      {ai && (ai.dims || ai.oneLine || ai.reason) && (
        <div className="rank-ai-sub small">
          {ai.dims && <div className="muted">简历 {ai.dims.resume} · 回答 {ai.dims.interview} · 综合素质 {ai.dims.quality}</div>}
          {ai.oneLine && <div style={{ marginTop: 3, fontWeight: 600 }}>{ai.oneLine}</div>}
          {ai.reason && <div className="muted" style={{ marginTop: 3, lineHeight: 1.65 }}>{ai.reason}</div>}
        </div>
      )}
    </div>
  );
}

export function PositionRanking({ onOpenCandidate, toast }: { onOpenCandidate: (id: string) => void; toast: (m: string) => void }) {
  const [candidates, setCandidates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [pos, setPos] = useState<string>(() => sessionStorage.getItem("rank.pos") || "");
  const [aiRank, setAiRank] = useState<Record<string, any> | null>(null); // 已面试组 AI 排:id -> {score,dims,oneLine}
  const [aiSummary, setAiSummary] = useState("");
  const [comparing, setComparing] = useState(false);
  const [aiRankNot, setAiRankNot] = useState<Record<string, any> | null>(null); // 未面试组 AI 排(按简历维度)
  const [aiSummaryNot, setAiSummaryNot] = useState("");
  const [comparingNot, setComparingNot] = useState(false);

  useEffect(() => {
    api.candidates().then((r) => setCandidates(r.candidates)).catch((e) => toast("加载失败:" + (e as Error).message)).finally(() => setLoading(false));
  }, [toast]);

  const positions = useMemo(() => {
    const m = new Map<string, string>();
    candidates.forEach((c) => { if (c.positionId && c.result !== "reject") m.set(c.positionId, c.positionRole || c.positionId); });
    return [...m.entries()].map(([id, role]) => ({ id, role, n: candidates.filter((c) => c.positionId === id && c.result !== "reject").length })).sort((a, b) => b.n - a.n);
  }, [candidates]);

  useEffect(() => { if (!pos && positions.length) setPos(positions[0].id); }, [positions, pos]);
  // 切职位:从 localStorage 读该职位之前存的 AI 排名(刷新/重开后仍在)
  useEffect(() => {
    if (!pos) return;
    sessionStorage.setItem("rank.pos", pos);
    const iv = loadAi(pos, "iv"); setAiRank(iv?.map || null); setAiSummary(iv?.summary || "");
    const nt = loadAi(pos, "nt"); setAiRankNot(nt?.map || null); setAiSummaryNot(nt?.summary || "");
  }, [pos]);

  const inPos = useMemo(() => candidates.filter((c) => c.positionId === pos && c.result !== "reject"), [candidates, pos]);
  const interviewedBase = useMemo(() => [...inPos.filter(isInterviewed)].sort((a, b) => interviewScore(b) - interviewScore(a) || byNameZh(a, b)), [inPos]);
  const notYetBase = useMemo(() => [...inPos.filter((c) => !isInterviewed(c))].sort((a, b) => screenScore(b) - screenScore(a) || byNameZh(a, b)), [inPos]);
  const interviewed = useMemo(() => {
    if (!aiRank) return interviewedBase;
    return [...interviewedBase].sort((a, b) => (aiRank[b.id]?.score ?? -1) - (aiRank[a.id]?.score ?? -1));
  }, [interviewedBase, aiRank]);
  const notYet = useMemo(() => {
    if (!aiRankNot) return notYetBase;
    // AI 排过的在前(按综合分),没排到的(超出前 12 的)按初筛排在后面
    return [...notYetBase].sort((a, b) => (aiRankNot[b.id]?.score ?? -1) - (aiRankNot[a.id]?.score ?? -1) || screenScore(b) - screenScore(a));
  }, [notYetBase, aiRankNot]);

  const AI_MAX = 12; // compareCandidates 一次最多对比的人数
  const runCompare = async (grp: string, group: any[], setMap: (m: Record<string, any>) => void, setSum: (s: string) => void, setBusy: (b: boolean) => void) => {
    const top = group.slice(0, AI_MAX);
    if (top.length < 2) { toast("满 2 人才能做 AI 综合排名"); return; }
    setBusy(true);
    try {
      const r = await api.compareCandidates(top.map((c) => c.id), "");
      const map: Record<string, any> = {};
      (r.ranking || []).forEach((x: any) => { map[x.id] = x; });
      setMap(map); setSum(r.summary || "");
      try { localStorage.setItem(aiKey(pos, grp), JSON.stringify({ map, summary: r.summary || "" })); } catch { /* 存储满/隐私模式忽略 */ }
      toast("AI 综合排名完成,已保存");
    } catch (e) { toast("AI 排名失败:" + (e as Error).message); }
    setBusy(false);
  };
  const aiCompare = () => runCompare("iv", interviewedBase, setAiRank, setAiSummary, setComparing);
  const aiCompareNot = () => runCompare("nt", notYetBase, setAiRankNot, setAiSummaryNot, setComparingNot);

  if (loading) return <p className="muted">加载中…</p>;

  return (
    <div>
      <div className="spread">
        <div>
          <h1 className="page-title">职位综合排名</h1>
          <p className="page-sub">按职位看在库人员排名 · 面试过与未面试各一组,都可点「AI 综合排名」按 实操能力(核心)/大厂经历/学历/沟通管理/出镜IP/电商经验 等维度排(已淘汰的在「不通过库」)</p>
        </div>
      </div>
      <div className="filter-bar" style={{ marginTop: 6 }}>
        <label className="filter-field">职位
          <select className="filter-select" value={pos} onChange={(e) => setPos(e.target.value)}>
            {positions.length === 0 && <option value="">(暂无)</option>}
            {positions.map((p) => <option key={p.id} value={p.id}>{p.role} ({p.n})</option>)}
          </select>
        </label>
        <span className="muted small">共 {inPos.length} 人 · 已面试 {interviewedBase.length} · 未面试 {notYet.length}</span>
      </div>

      {/* 已面试 · 综合排名(可 AI 三维度重排) */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="spread">
          <div className="section-h" style={{ marginTop: 0 }}>已面试 · 综合排名({interviewed.length})</div>
          {interviewedBase.length >= 2 && (
            <button className="btn sm primary" onClick={aiCompare} disabled={comparing}>
              {comparing ? "AI 排名中…(约 20-40s)" : aiRank ? "🤖 重新 AI 综合排名" : "🤖 AI 综合重排"}
            </button>
          )}
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          {aiRank
            ? "已由 AI 按 实操能力(核心)/大厂经历/学历/沟通管理/出镜IP/电商经验 等维度综合打分排序。"
            : "已出面试评级/结论,默认按综合表现(录用 > 面试评级)排;点「AI 综合重排」用 AI 多维度重新排。"}
          {interviewedBase.length > AI_MAX ? `(AI 综合重排取评级前 ${AI_MAX} 名,其余按评级排在后面)` : ""}
        </p>
        {aiRank && aiSummary && <div className="compare-summary" style={{ margin: "4px 0 10px" }}>🧭 {aiSummary}</div>}
        {interviewed.length === 0 ? <p className="muted small">暂无</p> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {interviewed.map((c, i) => <RankRow key={c.id} c={c} i={i} ai={aiRank?.[c.id]} onOpen={onOpenCandidate} />)}
          </div>
        )}
      </div>

      {/* 未面试 · 默认按初筛评级排,可 AI 综合排名(按简历多维度) */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="spread">
          <div className="section-h" style={{ marginTop: 0 }}>未面试 · 综合排名({notYet.length})</div>
          {notYetBase.length >= 2 && (
            <button className="btn sm primary" onClick={aiCompareNot} disabled={comparingNot}>
              {comparingNot ? "AI 排名中…(约 20-40s)" : aiRankNot ? "🤖 重新 AI 综合排名" : "🤖 AI 综合排名"}
            </button>
          )}
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          {aiRankNot
            ? "已由 AI 按 实操能力/大厂经历/学历/沟通管理/出镜IP/电商经验 等维度(基于简历)综合打分排序,可据此决定先面谁。"
            : "尚未面试,默认按 AI 初筛评级(推荐 > 待定 > 不推荐)排;点「AI 综合排名」用 AI 多维度(看简历)重新排,挑出最值得先面的。"}
          {notYetBase.length > AI_MAX ? `(AI 综合排名取初筛前 ${AI_MAX} 名;其余按初筛排在后面)` : ""}
        </p>
        {aiRankNot && aiSummaryNot && <div className="compare-summary" style={{ margin: "4px 0 10px" }}>🧭 {aiSummaryNot}</div>}
        {notYet.length === 0 ? <p className="muted small">暂无</p> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {notYet.map((c, i) => <RankRow key={c.id} c={c} i={i} ai={aiRankNot?.[c.id]} screenOnly={!aiRankNot} onOpen={onOpenCandidate} />)}
          </div>
        )}
      </div>
    </div>
  );
}
