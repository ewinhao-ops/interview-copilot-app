// 设置:多岗位画像 + 加权评分标准、AI 模型、数据备份。
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";

type Dim = { key: string; name: string; weight: number; criteria: string };
type Position = { id: string; role: string; aliases: string[]; summary: string; dimensions: Dim[]; advancement: string };
type Config = { positions: Position[]; defaultPositionId: string };

export function Settings({ toast }: { toast: (m: string) => void }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [activeId, setActiveId] = useState<string>("");
  const [ai, setAi] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [answerLimit, setAnswerLimit] = useState<number>(240);
  const [maxDuration, setMaxDuration] = useState<number>(60);
  const [inviteTtl, setInviteTtl] = useState<number>(48);
  const [savingItv, setSavingItv] = useState(false);
  const [brandName, setBrandName] = useState<string>("");
  const [savingBrand, setSavingBrand] = useState(false);

  useEffect(() => {
    api.jobProfile().then((r) => {
      const c = r.config as Config;
      setCfg(c);
      setActiveId(c.defaultPositionId || c.positions[0]?.id || "");
    });
    api.aiConfig().then((r) => setAi(r.config)).catch(() => undefined);
    api.interviewSettings().then((r) => { setAnswerLimit(r.settings.answerLimitSec); setMaxDuration(r.settings.maxDurationMin ?? 60); setInviteTtl(r.settings.inviteTtlHours ?? 48); }).catch(() => undefined);
    api.brandConfig().then((r) => setBrandName(r.brand.companyName || "")).catch(() => undefined);
  }, []);

  const saveBrand = async () => {
    setSavingBrand(true);
    try { const r = await api.saveBrand({ companyName: brandName, tagline: "AI 智能面试" }); setBrandName(r.brand.companyName); toast("公司名已保存 · 候选人面试页将显示它"); }
    catch (e) { toast("失败:" + (e as Error).message); }
    setSavingBrand(false);
  };

  const saveItv = async () => {
    setSavingItv(true);
    try {
      const r = await api.saveInterviewSettings({ answerLimitSec: answerLimit, maxDurationMin: maxDuration, inviteTtlHours: inviteTtl });
      setAnswerLimit(r.settings.answerLimitSec); setMaxDuration(r.settings.maxDurationMin ?? 60); setInviteTtl(r.settings.inviteTtlHours ?? 48); toast("面试设置已保存");
    } catch (e) { toast("失败:" + (e as Error).message); }
    setSavingItv(false);
  };

  const pos = useMemo(() => cfg?.positions.find((p) => p.id === activeId) || null, [cfg, activeId]);
  const weightTotal = useMemo(() => (pos ? pos.dimensions.reduce((s, d) => s + (Number(d.weight) || 0), 0) : 0), [pos]);

  const patchPos = (patch: Partial<Position>) =>
    setCfg((c) => (c ? { ...c, positions: c.positions.map((p) => (p.id === activeId ? { ...p, ...patch } : p)) } : c));
  const patchDim = (i: number, patch: Partial<Dim>) =>
    patchPos({ dimensions: (pos?.dimensions || []).map((d, j) => (j === i ? { ...d, ...patch } : d)) });

  const addPosition = () => {
    if (!cfg) return;
    const id = `pos-${(crypto.randomUUID?.() || String(Date.now())).slice(0, 8)}`;
    const np: Position = {
      id, role: "新岗位", aliases: [], summary: "",
      dimensions: [
        { key: "tech", name: "专业技术", weight: 30, criteria: "A:…\nB:…\nC:…\nD:…" },
        { key: "creativity", name: "创造力", weight: 15, criteria: "A:…\nB:…\nC:…\nD:…" },
        { key: "coordination", name: "协调性", weight: 10, criteria: "A:…\nB:…\nC:…\nD:…" },
        { key: "resilience", name: "创业期抗压能力", weight: 15, criteria: "A:…\nB:…\nC:…\nD:…" },
        { key: "management", name: "组织与管理能力", weight: 10, criteria: "A:…\nB:…\nC:…\nD:…" },
        { key: "communication", name: "语言表达与理解(团队协作)", weight: 20, criteria: "A:…\nB:…\nC:…\nD:…" },
      ],
      advancement: "",
    };
    setCfg({ ...cfg, positions: [...cfg.positions, np] });
    setActiveId(id);
  };

  const removePosition = () => {
    if (!cfg || cfg.positions.length <= 1 || !pos) return;
    if (!confirm(`删除岗位「${pos.role}」?`)) return;
    const rest = cfg.positions.filter((p) => p.id !== activeId);
    const def = cfg.defaultPositionId === activeId ? rest[0].id : cfg.defaultPositionId;
    setCfg({ positions: rest, defaultPositionId: def });
    setActiveId(rest[0].id);
  };

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    try { const r = await api.saveJobProfile(cfg); setCfg(r.config); toast("岗位画像已保存"); }
    catch (e) { toast("失败:" + (e as Error).message); }
    setSaving(false);
  };

  if (!cfg) return <p className="muted">加载中…</p>;
  return (
    <div>
      <h1 className="page-title">设置</h1>
      <p className="page-sub">系统按什么标准判断 · 初筛/出题/评判会按候选人岗位自动匹配下面对应的画像</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-h" style={{ marginTop: 0 }}>品牌(公司名)</div>
        <label>公司名(显示在候选人面试页的页头与页脚)</label>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <input style={{ maxWidth: 280 }} placeholder="例如:播尔AI" value={brandName} onChange={(e) => setBrandName(e.target.value)} />
          <button className="btn primary" onClick={saveBrand} disabled={savingBrand || !brandName.trim()}>{savingBrand ? "保存中…" : "保存"}</button>
        </div>
        <p className="muted small">候选人打开面试链接,页头会显示「{brandName.trim() || "(未设置)"}」。</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-h" style={{ marginTop: 0 }}>岗位画像与评分标准</div>

        {/* 岗位切换 */}
        <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          {cfg.positions.map((p) => (
            <button
              key={p.id}
              className={"btn" + (p.id === activeId ? " primary" : "")}
              onClick={() => setActiveId(p.id)}
            >
              {p.role}{cfg.defaultPositionId === p.id ? " ·默认" : ""}
            </button>
          ))}
          <button className="btn" onClick={addPosition}>+ 新增岗位</button>
        </div>

        {pos && (
          <>
            <label>岗位名称(用于匹配候选人岗位)</label>
            <input value={pos.role} onChange={(e) => patchPos({ role: e.target.value })} />

            <label>岗位别名(候选人岗位的其它写法,逗号分隔,匹配用)</label>
            <input
              value={(pos.aliases || []).join("、")}
              onChange={(e) => patchPos({ aliases: e.target.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) })}
              placeholder="如:AI-Agent应用开发工程师、FDE"
            />

            <label>岗位画像(初筛与评判都会用)</label>
            <textarea style={{ minHeight: 90 }} value={pos.summary} onChange={(e) => patchPos({ summary: e.target.value })} />

            <div className="section-h">
              评分维度(权重)
              <span className={"small"} style={{ marginLeft: 10, color: weightTotal === 100 ? "var(--muted, #888)" : "#e0a020" }}>
                合计 {weightTotal}%{weightTotal === 100 ? " ✓" : " — 建议调到 100%"}
              </span>
            </div>
            {pos.dimensions.map((d, i) => (
              <div key={i} style={{ marginBottom: 12, border: "1px solid var(--border, #2a2a2a)", borderRadius: 8, padding: 10 }}>
                <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <input style={{ flex: 1 }} value={d.name} onChange={(e) => patchDim(i, { name: e.target.value })} />
                  <input
                    type="number" min={0} max={100} style={{ width: 90 }} value={d.weight}
                    onChange={(e) => patchDim(i, { weight: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
                  />
                  <span className="muted small">%</span>
                </div>
                <textarea style={{ minHeight: 110 }} value={d.criteria} onChange={(e) => patchDim(i, { criteria: e.target.value })} />
              </div>
            ))}

            <label>推进标准</label>
            <textarea value={pos.advancement} onChange={(e) => patchPos({ advancement: e.target.value })} />

            <div className="row" style={{ marginTop: 14, gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary" onClick={save} disabled={saving}>{saving ? "保存中…" : "保存全部岗位"}</button>
              {cfg.defaultPositionId !== activeId && (
                <button className="btn" onClick={() => setCfg({ ...cfg, defaultPositionId: activeId })}>设为默认岗位</button>
              )}
              {cfg.positions.length > 1 && (
                <button className="btn" onClick={removePosition} style={{ color: "#d05050" }}>删除此岗位</button>
              )}
            </div>
            <p className="muted small" style={{ marginTop: 8 }}>
              匹配规则:按候选人岗位字段与上面「岗位名称/别名」模糊匹配;匹配不到时用默认岗位(当前:{cfg.positions.find((p) => p.id === cfg.defaultPositionId)?.role || "—"})。
            </p>
          </>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-h" style={{ marginTop: 0 }}>面试设置</div>
        <label>每题回答时长上限(秒)</label>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <input type="number" min={0} style={{ width: 140 }} value={answerLimit}
            onChange={(e) => setAnswerLimit(Math.max(0, Math.round(Number(e.target.value) || 0)))}
            disabled={answerLimit === 0} />
          <label style={{ margin: 0, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={answerLimit === 0}
              onChange={(e) => setAnswerLimit(e.target.checked ? 0 : 240)} />
            不限时(候选人手动点"结束回答"才进入下一题)
          </label>
        </div>
        <p className="muted small">默认 240 秒(4 分钟)。勾选"不限时"后,每题回答没有倒计时,候选人答完手动结束;读题 30 秒不变。</p>

        <label style={{ marginTop: 16 }}>整场总时长上限(分钟)</label>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <input type="number" min={0} style={{ width: 140 }} value={maxDuration}
            onChange={(e) => setMaxDuration(Math.max(0, Math.round(Number(e.target.value) || 0)))}
            disabled={maxDuration === 0} />
          <label style={{ margin: 0, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={maxDuration === 0}
              onChange={(e) => setMaxDuration(e.target.checked ? 0 : 60)} />
            不限总时长
          </label>
        </div>
        <p className="muted small">默认 60 分钟。候选人<b>开始作答后</b>必须在此时间内一次性连续答完;超时或中途离开,本轮即结束、同一链接<b>无法再进入</b>(可在候选人详情页「重新开启面试」放行)。设 0 / 勾选"不限总时长"则只受每题时长与"离开 10 分钟自动锁定"约束。</p>

        <label style={{ marginTop: 16 }}>邀约链接有效期(小时)</label>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <input type="number" min={1} style={{ width: 140 }} value={inviteTtl}
            onChange={(e) => setInviteTtl(Math.max(1, Math.round(Number(e.target.value) || 1)))} />
        </div>
        <p className="muted small">默认 48 小时。指<b>发出去的面试链接</b>可被点开、开始作答的窗口期;超过这个时间没点开,链接就过期(需要重新发起 / 重新开启)。这只限制"开始前",和上面"开始作答后的总时长"是两回事。改这里只影响<b>之后新发</b>的链接。</p>
        <div className="row" style={{ marginTop: 12 }}><button className="btn primary" onClick={saveItv} disabled={savingItv}>{savingItv ? "保存中…" : "保存面试设置"}</button></div>
      </div>

      {ai && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="section-h" style={{ marginTop: 0 }}>AI 模型</div>
          <p className="muted small">密钥由服务端持有(.env),此处只读展示掩码。各场景模型可在 .env 或后续切换。</p>
          <table className="table">
            <tbody>
              <tr><td className="muted">DeepSeek Key</td><td>{ai.deepSeekApiKey || "未配置"}</td></tr>
              <tr><td className="muted">MiMO Key</td><td>{ai.mimoApiKey || "未配置"}</td></tr>
              <tr><td className="muted">DashScope(转写) Key</td><td>{ai.dashScopeApiKey || "未配置"}</td></tr>
              <tr><td className="muted">初筛/评判模型</td><td>{ai.sceneProviders?.screening} / {ai.sceneProviders?.evaluationReport}</td></tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="section-h" style={{ marginTop: 0 }}>数据与备份</div>
        <p className="muted small">SQLite 单文件库存于服务器本地,每日定时备份(保留 30 天)。不放 iCloud 同步目录。</p>
      </div>
    </div>
  );
}
