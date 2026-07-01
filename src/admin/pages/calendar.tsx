// 日历:时间管理视图。自动汇总系统里的二面预约(含候选人自主挑的时间)+ 手动添加的沟通记录/面试安排。
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";

type Ev = {
  id: string; date: string; startTime?: string; endTime?: string;
  type: "second" | "interview" | "comm" | "note"; title: string;
  candidateId?: string; candidateName?: string; note?: string; outcome?: string;
  source: "booking" | "manual"; reviewStatus?: string; bookingId?: string;
};
const OUTCOME_MARK: Record<string, string> = { "录用": "🟢", "不录用": "🔴", "待定": "🟡" };

const TYPE_LABEL: Record<string, string> = { second: "二面预约", interview: "面试安排", comm: "沟通记录", note: "其它" };
const chipClass = (e: Ev) => e.source === "booking" ? (e.reviewStatus === "approved" ? "second-approved" : "second-pending") : e.type;
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const fmtTime = (e: Ev) => e.startTime ? (e.endTime ? `${e.startTime}-${e.endTime}` : e.startTime) : "全天";

export function CalendarView({ onOpenCandidate, toast }: { onOpenCandidate: (id: string) => void; toast: (m: string) => void }) {
  const today = new Date();
  const todayStr = ymd(today.getFullYear(), today.getMonth(), today.getDate());
  const [cursor, setCursor] = useState<{ y: number; m: number }>({ y: today.getFullYear(), m: today.getMonth() });
  const [bookings, setBookings] = useState<any[]>([]);
  const [manual, setManual] = useState<any[]>([]);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [dayView, setDayView] = useState<string | null>(null); // 点格子"+N 项"展开某天全部事件
  const [editing, setEditing] = useState<any | null>(null); // 新增/编辑手动事件
  const [mention, setMention] = useState<any[]>([]); // 标题框检索/@提及候选人的下拉建议
  const [mentionRepl, setMentionRepl] = useState(""); // 选中候选人时,标题末尾要被名字替换掉的那段("@李" 或 末尾后缀"李")
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // 计算标题末尾的检索词:① @后跟词 → @触发(空 @ 列前几个);② 否则取末尾连续中文/字母,
  // 对它做后缀匹配("跟李"会退到"李"才匹配到李姓),返回要替换的那段 repl 与命中候选人。
  const computeMention = (title: string): { repl: string; hits: any[] } => {
    const at = title.match(/@([^@\s]{0,12})$/);
    if (at) {
      const q = at[1].toLowerCase();
      const hits = q ? candidates.filter((c) => String(c.name || "").toLowerCase().includes(q)) : candidates;
      return { repl: at[0], hits: hits.slice(0, 6) };
    }
    const tail = (title.match(/[一-龥A-Za-z]{1,8}$/) || [""])[0];
    for (let i = 0; i < tail.length; i++) {
      const q = tail.slice(i).toLowerCase();
      const hits = candidates.filter((c) => String(c.name || "").toLowerCase().includes(q));
      if (hits.length) return { repl: tail.slice(i), hits: hits.slice(0, 6) };
    }
    return { repl: "", hits: [] };
  };
  const onTitleChange = (v: string) => {
    setEditing((s: any) => ({ ...s, title: v }));
    const { repl, hits } = computeMention(v);
    setMentionRepl(repl); setMention(hits);
  };
  const pickMention = (c: any) => {
    setEditing((s: any) => {
      const t: string = s.title || "";
      const newT = mentionRepl && t.endsWith(mentionRepl) ? t.slice(0, t.length - mentionRepl.length) + c.name : t + c.name;
      return { ...s, title: newT, candidateId: c.id };
    });
    setMention([]); setMentionRepl("");
  };

  const load = () => Promise.all([api.bookings(), api.calendarEvents(), api.candidates()])
    .then(([b, e, c]) => { setBookings(b.bookings || []); setManual(e.events || []); setCandidates(c.candidates || []); })
    .catch((err) => toast("加载失败:" + (err as Error).message)).finally(() => setLoading(false));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // 合并二面预约 + 手动事件,按日期分组
  const byDate = useMemo(() => {
    const map: Record<string, Ev[]> = {};
    const push = (d: string, ev: Ev) => { (map[d] ||= []).push(ev); };
    bookings.forEach((b) => {
      const rs = b.reviewStatus ?? "pending";
      if (!b.slot?.date || rs === "rejected" || rs === "cancelled") return;
      push(b.slot.date, { id: "bk-" + b.id, bookingId: b.id, date: b.slot.date, startTime: b.slot.start, endTime: b.slot.end, type: "second", title: `${b.candidateName || "候选人"} · 二面`, candidateId: b.candidateId, source: "booking", reviewStatus: rs });
    });
    manual.forEach((e) => push(e.date, { ...e, source: "manual" }));
    Object.values(map).forEach((arr) => arr.sort((a, b) => (a.startTime || "99:99").localeCompare(b.startTime || "99:99")));
    return map;
  }, [bookings, manual]);

  const { y, m } = cursor;
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  const prevMonth = () => setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }));
  const nextMonth = () => setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }));
  const goToday = () => { setCursor({ y: today.getFullYear(), m: today.getMonth() }); };

  const openNew = (date?: string) => { setMention([]); setEditing({ id: "", date: date || todayStr, type: "comm", title: "", startTime: "", endTime: "", candidateId: "", note: "", outcome: "" }); };
  // 点事件块:手动事件→编辑;二面→跳候选人详情
  const openEvent = (e: Ev) => { if (e.source === "manual") openEdit(e); else if (e.candidateId) onOpenCandidate(e.candidateId); };
  const openEdit = (e: Ev) => { if (e.source === "manual") { setMention([]); setEditing({ ...e, startTime: e.startTime || "", endTime: e.endTime || "", candidateId: e.candidateId || "", note: e.note || "", outcome: (e as any).outcome || "" }); } };
  const save = async () => {
    if (!editing.title.trim()) { toast("请填写标题"); return; }
    setBusy(true);
    try {
      const cand = candidates.find((c) => c.id === editing.candidateId);
      await api.saveCalendarEvent({
        id: editing.id || undefined, date: editing.date, title: editing.title.trim(), type: editing.type,
        startTime: editing.startTime || undefined, endTime: editing.endTime || undefined,
        candidateId: editing.candidateId || undefined, candidateName: cand?.name || undefined, note: editing.note || undefined,
        outcome: editing.type === "interview" && editing.outcome ? editing.outcome : undefined,
      });
      toast("已保存"); setEditing(null); await load();
    } catch (e) { toast("保存失败:" + (e as Error).message); }
    setBusy(false);
  };
  const remove = async () => {
    if (!editing?.id || !window.confirm("删除这条记录?")) return;
    setBusy(true);
    try { await api.deleteCalendarEvent(editing.id); toast("已删除"); setEditing(null); await load(); }
    catch (e) { toast("删除失败:" + (e as Error).message); }
    setBusy(false);
  };

  if (loading) return <p className="muted">加载中…</p>;
  const monthCount = Object.entries(byDate).filter(([d]) => d.startsWith(`${y}-${pad(m + 1)}`)).reduce((s, [, arr]) => s + arr.length, 0);

  return (
    <div>
      <div className="spread">
        <div>
          <h1 className="page-title">面试日历</h1>
          <p className="page-sub">面试安排一览 · 二面预约(含候选人自主挑的时间)自动汇总 · <b>点空白格加安排,点「面试安排」可填录用结果与小结</b></p>
        </div>
        <button className="btn primary" onClick={() => openNew()}>➕ 添加记录</button>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="calv-bar">
          <div className="row" style={{ gap: 6, alignItems: "center" }}>
            <button className="btn sm" onClick={prevMonth}>‹</button>
            <span className="calv-month">{y} 年 {m + 1} 月</span>
            <button className="btn sm" onClick={nextMonth}>›</button>
            <button className="btn sm ghost" onClick={goToday}>今天</button>
          </div>
          <span className="muted small">本月 {monthCount} 项安排</span>
        </div>

        <div className="calv-grid calv-dow-row">
          {["日", "一", "二", "三", "四", "五", "六"].map((d, i) => <div key={i} className={"calv-dow" + (i === 0 || i === 6 ? " wk" : "")}>{d}</div>)}
        </div>
        <div className="calv-grid">
          {cells.map((d, i) => {
            if (d == null) return <div key={i} className="calv-cell empty" />;
            const ds = ymd(y, m, d);
            const evs = byDate[ds] || [];
            const dow = (firstDow + d - 1) % 7;
            return (
              <div key={i} className={"calv-cell" + (ds === todayStr ? " today" : "")} onClick={() => openNew(ds)} title="点空白处添加记录">
                <div className="calv-daynum">{d}{ds === todayStr && <span className="calv-todaytag">今</span>}</div>
                {evs.slice(0, 3).map((e) => (
                  <div key={e.id} className={"calv-chip " + chipClass(e)} title={`${fmtTime(e)} ${e.title}${e.outcome ? "(" + e.outcome + ")" : ""}（点击查看/编辑）`} onClick={(ev) => { ev.stopPropagation(); openEvent(e); }}>{e.outcome ? OUTCOME_MARK[e.outcome] + " " : ""}{e.startTime ? e.startTime + " " : ""}{e.title}</div>
                ))}
                {evs.length > 3 && <div className="calv-more" onClick={(ev) => { ev.stopPropagation(); setDayView(ds); }}>+{evs.length - 3} 项</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* 点"+N 项"展开某天全部事件 */}
      {dayView && (
        <div className="modal-bg" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) setDayView(null); }}>
          <div className="modal" onMouseDown={(ev) => ev.stopPropagation()}>
            <div className="spread" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>{dayView.replace(/-/g, "/")} · {(byDate[dayView] || []).length} 项</h2>
              <a onClick={() => setDayView(null)}>关闭 ✕</a>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(byDate[dayView] || []).map((e) => (
                <div key={e.id} className="calv-item">
                  <span className={"calv-dot " + chipClass(e)} />
                  <span className="calv-time">{fmtTime(e)}</span>
                  <div className="grow">
                    <b>{e.outcome ? OUTCOME_MARK[e.outcome] + " " : ""}{e.title}</b>
                    <span className="muted small" style={{ marginLeft: 8 }}>{TYPE_LABEL[e.type]}{e.outcome ? " · " + e.outcome : ""}</span>
                    {e.note && <div className="muted small" style={{ marginTop: 2 }}>{e.note}</div>}
                  </div>
                  {e.candidateId && <a className="small" onClick={() => onOpenCandidate(e.candidateId!)}>候选人 →</a>}
                  {e.source === "manual" ? <a className="small" onClick={() => { setDayView(null); openEdit(e); }}>编辑</a> : <span className="muted small" style={{ minWidth: 56, textAlign: "right" }}>{e.reviewStatus === "approved" ? "已确认" : "待确认"}</span>}
                </div>
              ))}
            </div>
            <button className="btn primary wide" style={{ marginTop: 14 }} onClick={() => { const d = dayView; setDayView(null); openNew(d); }}>➕ 在这天添加记录</button>
          </div>
        </div>
      )}

      {editing && (
        <div className="modal-bg" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) setEditing(null); }}>
          <div className="modal" onMouseDown={(ev) => ev.stopPropagation()}>
            <div className="spread" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>{editing.id ? "编辑记录" : "添加记录"}</h2>
              <a onClick={() => setEditing(null)}>关闭 ✕</a>
            </div>
            <label>类型</label>
            <div className="row" style={{ gap: 8 }}>
              {(["comm", "interview", "note"] as const).map((t) => (
                <button key={t} className={"btn sm " + (editing.type === t ? "primary" : "")} onClick={() => setEditing((s: any) => ({ ...s, type: t }))}>{TYPE_LABEL[t]}</button>
              ))}
            </div>
            <label>标题 *<span className="muted small" style={{ fontWeight: 400, marginLeft: 6 }}>输入姓氏或 @ 可从简历库检索候选人</span></label>
            <div className="mention-wrap">
              <input value={editing.title} onChange={(e) => onTitleChange(e.target.value)} placeholder="如:跟 @李… 沟通入职 / 复试张三" />
              {mention.length > 0 && (
                <div className="mention-pop">
                  {mention.map((c) => (
                    <div key={c.id} className="mention-item" onMouseDown={(e) => { e.preventDefault(); pickMention(c); }}>
                      <b>{c.name}</b>
                      <span className="muted small">{[c.positionRole || c.role, c.eduDegree, c.currentCity].filter(Boolean).join(" · ")}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="row" style={{ gap: 10 }}>
              <div style={{ flex: 1 }}><label>日期 *</label><input className="picker-input" type="date" value={editing.date} onClick={(e) => (e.currentTarget as any).showPicker?.()} onChange={(e) => setEditing((s: any) => ({ ...s, date: e.target.value }))} /></div>
              <div style={{ flex: 1 }}><label>开始</label><input className="picker-input" type="time" value={editing.startTime} onClick={(e) => (e.currentTarget as any).showPicker?.()} onChange={(e) => setEditing((s: any) => ({ ...s, startTime: e.target.value }))} /></div>
              <div style={{ flex: 1 }}><label>结束</label><input className="picker-input" type="time" value={editing.endTime} onClick={(e) => (e.currentTarget as any).showPicker?.()} onChange={(e) => setEditing((s: any) => ({ ...s, endTime: e.target.value }))} /></div>
            </div>
            <label>关联候选人(可选)</label>
            <select value={editing.candidateId} onChange={(e) => setEditing((s: any) => ({ ...s, candidateId: e.target.value }))}>
              <option value="">(不关联)</option>
              {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.positionRole ? ` · ${c.positionRole}` : ""}</option>)}
            </select>
            {editing.type === "interview" && editing.candidateId && <p className="muted small" style={{ margin: "6px 0 0", color: "var(--gold)" }}>💡 这条「面试安排」会在该候选人打开面试链接时提醒他(只显示日期时间+标题,不含小结)。</p>}
            {editing.type === "interview" && (
              <>
                <label>面试结果<span className="muted small" style={{ fontWeight: 400, marginLeft: 6 }}>面试结束后填,日历上直接显示</span></label>
                <div className="row" style={{ gap: 8 }}>
                  {(["录用", "不录用", "待定"] as const).map((o) => (
                    <button key={o} className={"btn sm " + (editing.outcome === o ? "primary" : "")} onClick={() => setEditing((s: any) => ({ ...s, outcome: s.outcome === o ? "" : o }))}>{OUTCOME_MARK[o]} {o}</button>
                  ))}
                </div>
              </>
            )}
            <label>{editing.type === "interview" ? "面试小结 / 其他信息(可选)" : "备注(可选)"}</label>
            <textarea style={{ minHeight: 70 }} value={editing.note} onChange={(e) => setEditing((s: any) => ({ ...s, note: e.target.value }))} placeholder={editing.type === "interview" ? "这场面试表现如何、亮点 / 顾虑、其他需要记的信息…" : "沟通内容 / 注意事项…"} />
            <div className="row" style={{ marginTop: 14, justifyContent: "space-between" }}>
              <div>{editing.id && <button className="btn" style={{ color: "var(--bad)", borderColor: "rgba(255,90,90,.4)" }} onClick={remove} disabled={busy}>删除</button>}</div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" onClick={() => setEditing(null)}>取消</button>
                <button className="btn primary" onClick={save} disabled={busy}>{busy ? "保存中…" : "保存"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
