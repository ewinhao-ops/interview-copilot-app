import React, { useEffect, useState } from "react";
import { api } from "../api.js";

// 在某 YYYY-MM-DD 上减 n 天(按本地日期算,避免时区偏移)
function dateMinus(ds: string, n: number): string {
  const [y, m, d] = ds.split("-").map(Number);
  const dt = new Date(y, m - 1, d - n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// 二面时间相对今天的提示("今天/明天/MM-DD")
function whenLabel(date?: string): { text: string; cls: string } {
  if (!date) return { text: "", cls: "" };
  const today = new Date(); const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const d = new Date(date + "T00:00:00");
  const days = Math.round((d.getTime() - t.getTime()) / 86400000);
  if (days <= 0) return { text: "今天", cls: "urgent" };
  if (days === 1) return { text: "明天", cls: "soon" };
  if (days <= 7) return { text: `${days} 天后`, cls: "soon" };
  return { text: date.slice(5), cls: "" };
}

export function Workbench({ onOpenCandidate, toast, goto }: { onOpenCandidate: (id: string) => void; toast: (m: string) => void; goto?: (zone: string, opts?: { stage?: string }) => void }) {
  const [wb, setWb] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [reviewBusy, setReviewBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [recRange, setRecRange] = useState<"today" | "7d" | "all">("today"); // AI 推荐桶的日期范围
  const [recExpanded, setRecExpanded] = useState(false); // AI 推荐桶是否展开全部

  const load = () => api.today().then((r) => setWb(r.workbench)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const runScreening = async () => {
    setRunning(true); setMsg("");
    try {
      const r = await api.runScreening();
      setMsg(`初筛完成:${r.screened} 人`);
      await load();
    } catch (e) { setMsg(`失败:${(e as Error).message}`); }
    setRunning(false);
  };

  const review = async (id: string, status: "approved" | "rejected") => {
    if (status === "rejected" && !window.confirm("拒绝/改约会作废候选人已挑的时间,需要重新给他时段。确定?")) return;
    setReviewBusy(id);
    try { await api.reviewBooking(id, status); toast(status === "approved" ? "已确认二面时间" : "已拒绝,可重新给他时间"); await load(); }
    catch (e) { toast("失败:" + (e as Error).message); }
    setReviewBusy("");
  };

  if (loading) return <p className="muted">加载中…</p>;
  const c = wb.counts;
  const upcoming = wb.upcomingInterviews || [];
  // 点数字卡 -> 平滑滚动到下方对应的详情桶,并短暂高亮(页面短时也有明确反馈)
  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("wb-flash");
    setTimeout(() => el.classList.remove("wb-flash"), 1300);
  };
  return (
    <div>
      <div className="spread">
        <div>
          <h1 className="page-title">今日工作台</h1>
          <p className="page-sub">我今天要处理什么</p>
        </div>
        <button className="btn primary" onClick={runScreening} disabled={running}>{running ? "初筛中…" : "立即跑今日初筛"}</button>
      </div>
      {msg && <p className="muted">{msg}</p>}

      <div className="stat-grid">
        <div className="stat clickable" title="AI 初筛评级为“推荐”、还没给他们发面试链接的候选人 —— 等你去发起面试。点击查看名单。" onClick={() => scrollTo("wb-recommended")}><div className="n">{c.recommended}</div><div className="l">推荐待发起面试</div></div>
        <div className="stat clickable" title="面试报告已生成、还没标记通过/不通过的候选人。点击查看名单。" onClick={() => scrollTo("wb-reports")}><div className="n">{c.reportsReady}</div><div className="l">报告待你决定</div></div>
        <div className="stat clickable" title="候选人已挑了二面时间、等你确认的。点击查看名单。" onClick={() => scrollTo("wb-pending")}><div className="n" style={{ color: c.pendingBookings ? "var(--warn)" : undefined }}>{c.pendingBookings}</div><div className="l">二面待确认</div></div>
        <div className="stat clickable" title="已确认、今天及以后即将进行的二面。点击查看名单。" onClick={() => scrollTo("wb-upcoming")}><div className="n" style={{ color: (c.upcomingInterviews ?? upcoming.length) ? "var(--ok)" : undefined }}>{c.upcomingInterviews ?? upcoming.length}</div><div className="l">即将进行二面</div></div>
        <div className="stat clickable" title="发出去的面试链接即将或已经过期、候选人还没作答的。点击查看名单。" onClick={() => scrollTo("wb-expiring")}><div className="n" style={{ color: c.expiringInvites ? "var(--warn)" : undefined }}>{c.expiringInvites}</div><div className="l">邀约链接将过期</div></div>
      </div>

      {/* 二面提醒:已确认、即将进行的二面,放最上方,别错过 */}
      {upcoming.length > 0 && (
        <Bucket id="wb-upcoming" title="🔔 二面提醒 · 已确认即将进行" rows={upcoming} empty=""
          render={(b: any) => {
            const w = whenLabel(b.slot?.date);
            return (
              <div className={"list-row" + (b.candidateId ? " clickable" : "")} key={b.id} onClick={() => b.candidateId && onOpenCandidate(b.candidateId)}>
                {w.text && <span className={"when-badge " + w.cls}>{w.text}</span>}
                <div className="grow"><b>{b.candidateName}</b> <span className="muted small">{b.slot?.date} {b.slot?.start}-{b.slot?.end}</span></div>
                <span className="ok small">已确认</span>
                {b.candidateId && <button className="btn sm" onClick={(e) => { e.stopPropagation(); onOpenCandidate(b.candidateId); }}>查看候选人 →</button>}
              </div>
            );
          }} />
      )}

      {(() => {
        const all: any[] = wb.recommendedToInterview || [];
        const todayStr: string = wb.todayStr || "";
        const cut7 = dateMinus(todayStr, 6); // 含今天共 7 天
        const inRange = (x: any) => recRange === "all" ? true : recRange === "7d" ? x.screenedAt >= cut7 : x.screenedAt === todayStr;
        const list = all.filter(inRange);
        const REC_LIMIT = 8;
        const shown = recExpanded ? list : list.slice(0, REC_LIMIT);
        const tabs: Array<["today" | "7d" | "all", string]> = [["today", "今天"], ["7d", "近 7 天"], ["all", "全部"]];
        return (
          <div id="wb-recommended" style={{ scrollMarginTop: 16 }}>
            <div className="spread" style={{ alignItems: "center" }}>
              <div className="section-h" style={{ margin: 0 }}>AI 推荐 · 待发起面试 <span className="muted small">({list.length})</span></div>
              <div className="row" style={{ gap: 6 }}>
                {tabs.map(([k, lab]) => <button key={k} className={"btn sm " + (recRange === k ? "primary" : "")} onClick={() => { setRecRange(k); setRecExpanded(false); }}>{lab}</button>)}
              </div>
            </div>
            {list.length === 0 ? <p className="muted small">{recRange === "today" ? "今天暂无新推荐;切到「近 7 天 / 全部」可看之前的。" : "该时间范围内暂无待发起的推荐。"}</p> : shown.map((s: any) => (
              <div className="list-row clickable" key={s.id} onClick={() => s.candidate && onOpenCandidate(s.candidate.id)}>
                <span className="rating 推荐">推荐</span>
                <div className="grow"><b>{s.candidate?.name || "?"}</b> <span className="muted small">{s.candidate?.role || ""}</span></div>
                <span className="muted small">{s.generatedQuestionCount || 0} 道定制题已备</span>
                <button className="btn sm primary" disabled={!s.candidate} onClick={(e) => { e.stopPropagation(); s.candidate && onOpenCandidate(s.candidate.id); }}>去发起面试 →</button>
              </div>
            ))}
            {list.length > REC_LIMIT && (
              <a className="more-link" onClick={() => setRecExpanded((v) => !v)}>{recExpanded ? "收起 ↑" : `查看更多(还有 ${list.length - REC_LIMIT} 个) ↓`}</a>
            )}
          </div>
        );
      })()}

      {(() => {
        const rr: any[] = wb.reportsReady || [];
        const pending = rr.filter((x) => !x.decided);
        const decided = rr.filter((x) => x.decided);
        const PEND_LIMIT = 8, DEC_LIMIT = 5;
        const row = (x: any) => (
          <div className={"list-row clickable" + (x.decided ? " decided" : "")} key={x.evaluation.id} onClick={() => x.candidate && onOpenCandidate(x.candidate.id)}>
            {x.decided
              ? <span className={`rating ${x.decided === "pass" ? "推荐" : "不推荐"}`}>{x.decided === "pass" ? "✅ 已通过" : "❌ 已不通过"}</span>
              : <span className={`rating ${x.evaluation.recommendation || "待定"}`}>{x.evaluation.recommendation || "待定"}</span>}
            <div className="grow"><b>{x.candidate?.name}</b> <span className="muted small">{x.evaluation.summary?.slice(0, 50)}</span></div>
            <span className="muted small">评级 {x.evaluation.grade}</span>
            <button className="btn sm primary" disabled={!x.candidate} onClick={(e) => { e.stopPropagation(); x.candidate && onOpenCandidate(x.candidate.id); }}>{x.decided ? "查看 →" : "查看 / 决定 →"}</button>
          </div>
        );
        return (
          <div id="wb-reports" style={{ scrollMarginTop: 16 }}>
            <div className="section-h">报告已出 · 待你决定 <span className="muted small">({pending.length})</span></div>
            {pending.length === 0 ? <p className="muted small">暂无待决定报告</p> : pending.slice(0, PEND_LIMIT).map(row)}
            {pending.length > PEND_LIMIT && (
              <a className="more-link" onClick={() => goto?.("talent", { stage: "reviewed" })}>还有 {pending.length - PEND_LIMIT} 个待决定 · 去人才库查看全部 →</a>
            )}
            {decided.length > 0 && (
              <>
                <div className="muted small" style={{ margin: "10px 0 6px" }}>最近已决定</div>
                {decided.slice(0, DEC_LIMIT).map(row)}
                {decided.length > DEC_LIMIT && <a className="more-link" onClick={() => goto?.("talent")}>更多已决定的去人才库 / 不通过库查看 →</a>}
              </>
            )}
          </div>
        );
      })()}

      <Bucket id="wb-pending" title="二面预约 · 待确认(候选人已挑时间)" rows={wb.pendingBookings} empty="暂无待确认预约"
        render={(b: any) => (
          <div className={"list-row" + (b.candidateId ? " clickable" : "")} key={b.id} onClick={() => b.candidateId && onOpenCandidate(b.candidateId)}>
            <div className="grow"><b>{b.candidateName}</b> <span className="muted small">{b.slot?.date} {b.slot?.start}-{b.slot?.end}</span></div>
            <button className="btn sm primary" disabled={reviewBusy === b.id} onClick={(e) => { e.stopPropagation(); review(b.id, "approved"); }}>{reviewBusy === b.id ? "…" : "确认"}</button>
            <button className="btn sm" disabled={reviewBusy === b.id} onClick={(e) => { e.stopPropagation(); review(b.id, "rejected"); }}>拒绝/改约</button>
          </div>
        )} />

      {wb.expiringInvites.length > 0 && (
        <Bucket id="wb-expiring" title="邀约链接 · 即将/已过期" rows={wb.expiringInvites} empty=""
          render={(i: any) => (
            <div className={"list-row" + (i.candidateId ? " clickable" : "")} key={i.id} onClick={() => i.candidateId && onOpenCandidate(i.candidateId)}>
              <div className="grow"><b>{i.candidate_name || "候选人"}</b></div>
              <span className={i.expired ? "bad small" : "warn small"}>{i.expired ? "已过期" : `剩 ${i.hoursLeft}h`}</span>
              {i.candidateId && <button className="btn sm" onClick={(e) => { e.stopPropagation(); onOpenCandidate(i.candidateId); }}>查看 / 重新发起 →</button>}
            </div>
          )} />
      )}
    </div>
  );
}

function Bucket({ title, rows, render, empty, id }: { title: string; rows: any[]; render: (r: any) => React.ReactNode; empty: string; id?: string }) {
  return (
    <div id={id} style={{ scrollMarginTop: 16 }}>
      <div className="section-h">{title} <span className="muted small">({rows.length})</span></div>
      {rows.length === 0 ? (empty ? <p className="muted small">{empty}</p> : null) : rows.map(render)}
    </div>
  );
}
