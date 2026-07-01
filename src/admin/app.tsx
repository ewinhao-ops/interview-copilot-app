import React, { useEffect, useState } from "react";
import { api, Unauthorized } from "./api.js";
import { Workbench } from "./pages/workbench.js";
import { TalentPool } from "./pages/talent.js";
import { PositionRanking } from "./pages/ranking.js";
import { CandidateDetail } from "./pages/detail.js";
import { CalendarView } from "./pages/calendar.js";
import { Settings } from "./pages/settings.js";

type Zone = "today" | "talent" | "ranking" | "rejected" | "calendar" | "settings";
const NAV: Array<{ key: Zone; icon: string; label: string }> = [
  { key: "today", icon: "📋", label: "今日工作台" },
  { key: "talent", icon: "👥", label: "人才库" },
  { key: "ranking", icon: "🏆", label: "职位排名" },
  { key: "rejected", icon: "🗂", label: "不通过库" },
  { key: "calendar", icon: "📆", label: "面试日历" },
  { key: "settings", icon: "⚙️", label: "设置" },
];

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [zone, setZone] = useState<Zone>("today");
  const [openCandidate, setOpenCandidate] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState("");

  useEffect(() => { api.me().then((r) => setAuthed(r.authenticated)).catch(() => setAuthed(false)); }, []);
  const toast = (m: string) => { setToastMsg(m); setTimeout(() => setToastMsg(""), 2600); };

  if (authed === null) return <div className="login-screen"><p className="muted">加载中…</p></div>;
  if (!authed) return <Login onOk={() => setAuthed(true)} />;

  const go = (z: Zone) => { setZone(z); setOpenCandidate(null); };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">🐴 面试工作台</div>
        {NAV.map((n) => (
          <div key={n.key} className={`nav-item ${zone === n.key && !openCandidate ? "active" : ""}`} onClick={() => go(n.key)}>
            <span>{n.icon}</span><span>{n.label}</span>
          </div>
        ))}
        <div className="sidebar-foot">
          <a className="muted small" onClick={async () => { await api.logout().catch(() => undefined); setAuthed(false); }}>退出登录</a>
        </div>
      </aside>
      <main className="main">
        {openCandidate ? (
          <CandidateDetail candidateId={openCandidate} onBack={() => setOpenCandidate(null)} toast={toast} />
        ) : zone === "today" ? (
          <Workbench onOpenCandidate={setOpenCandidate} toast={toast} goto={(z, opts) => { if (opts?.stage) sessionStorage.setItem("tp.stage", opts.stage); setOpenCandidate(null); setZone(z as Zone); }} />
        ) : zone === "talent" ? (
          <TalentPool key="talent" onOpenCandidate={setOpenCandidate} toast={toast} />
        ) : zone === "ranking" ? (
          <PositionRanking onOpenCandidate={setOpenCandidate} toast={toast} />
        ) : zone === "rejected" ? (
          <TalentPool key="rejected" rejected onOpenCandidate={setOpenCandidate} toast={toast} />
        ) : zone === "calendar" ? (
          <CalendarView onOpenCandidate={setOpenCandidate} toast={toast} />
        ) : (
          <Settings toast={toast} />
        )}
      </main>
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}

function Login({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try { await api.login(pw); onOk(); }
    catch (e) { setErr(e instanceof Unauthorized ? "密码错误" : (e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>🐴 面试工作台 · 登录</h1>
        <label>管理员密码</label>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {err && <p className="bad small" style={{ marginTop: 8 }}>{err}</p>}
        <button className="btn primary" style={{ width: "100%", marginTop: 18 }} disabled={busy}>{busy ? "登录中…" : "登录"}</button>
      </form>
    </div>
  );
}
