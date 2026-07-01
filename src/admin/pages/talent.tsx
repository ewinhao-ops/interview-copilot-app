// 人才库:合并原简历库+候选人,按阶段筛选 + 搜索。
import React, { useEffect, useMemo, useState } from "react";
import { api, copyText } from "../api.js";
import { STAGES, stageMeta } from "../stages.js";

// 列表视图状态(排序/筛选)持久化到 sessionStorage:
// 打开候选人详情会卸载 TalentPool,返回时重新挂载,普通 useState 会丢失排序/筛选。
// 用 sessionStorage 在标签页生命周期内保留,返回/切换页面后自动恢复。
function usePersistentState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [v, setV] = useState<T>(() => {
    try { const raw = sessionStorage.getItem(key); return raw != null ? (JSON.parse(raw) as T) : initial; }
    catch { return initial; }
  });
  useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* 隐私模式等写入失败时忽略,退化为不持久化 */ } }, [key, v]);
  return [v, setV];
}

export function TalentPool({ onOpenCandidate, toast, rejected }: { onOpenCandidate: (id: string) => void; toast: (m: string) => void; rejected?: boolean }) {
  const [candidates, setCandidates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // 排序/筛选状态持久化(返回详情页后保留;见 usePersistentState)。主库与「不通过库」各用一套键,互不干扰。
  const K = rejected ? "tpRej." : "tp.";
  const [stage, setStage] = usePersistentState<string>(K + "stage", "all");
  const [roleFilter, setRoleFilter] = usePersistentState<string>(K + "role", "");
  const [q, setQ] = usePersistentState(K + "q", "");
  const [fTopSchool, setFTopSchool] = usePersistentState(K + "fTopSchool", false);   // 只看 985/211
  const [fShuangyiliu, setFShuangyiliu] = usePersistentState(K + "fShuangyiliu", false); // 只看双一流
  const [fPostgrad, setFPostgrad] = usePersistentState(K + "fPostgrad", false);     // 只看硕士及以上
  const [fLocal, setFLocal] = usePersistentState(K + "fLocal", false);           // 只看徐州本地
  const [fStar, setFStar] = usePersistentState(K + "fStar", false);             // 只看收藏
  const [sortKey, setSortKey] = usePersistentState<string>(K + "sortKey", "");    // 列排序
  const [sortDir, setSortDir] = usePersistentState<"asc" | "desc">(K + "sortDir", "desc");
  const [syncing, setSyncing] = useState(false);
  const [liveMap, setLiveMap] = useState<Record<string, any>>({}); // 候选人实时面试进度(轮询)
  const [cleaning, setCleaning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // 多选对比
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareFocus, setCompareFocus] = useState("");
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<{ ranking: any[]; summary: string } | null>(null);
  const [collectOpen, setCollectOpen] = useState(false);
  const [collectForm, setCollectForm] = useState({ name: "", role: "", type: "normal" as "normal" | "anchor", focus: "" });
  const [collectBusy, setCollectBusy] = useState(false);
  const [collectResult, setCollectResult] = useState<{ token: string; url: string; questions: any[] } | null>(null);
  const [collectCats, setCollectCats] = useState<Array<{ key: string; name: string; n: number }>>([]);

  const clickSort = (k: string) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(["name", "role", "source", "stage"].includes(k) ? "asc" : "desc"); }
  };

  const [libUrl, setLibUrl] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const reload = () => api.candidates().then((r) => { setCandidates(r.candidates); setLoadErr(""); }).catch((e) => { setLoadErr((e as Error).message || "加载失败"); throw e; });
  useEffect(() => { reload().catch(() => undefined).finally(() => setLoading(false)); }, []);
  useEffect(() => { api.resumeLibrary().then((r) => setLibUrl(r.url)).catch(() => undefined); }, []);

  const del = async (e: React.MouseEvent, c: any) => {
    e.stopPropagation();
    if (!window.confirm(`确定删除候选人「${c.name}」吗?\n会一并删除其简历、面试、作答、作品与评估,且不可恢复。`)) return;
    try { await api.deleteCandidate(c.id); setSelected((s) => { const n = new Set(s); n.delete(c.id); return n; }); toast(`已删除 ${c.name}`); await reload(); }
    catch (err) { toast("删除失败:" + (err as Error).message); }
  };

  const syncFeishu = async () => {
    setSyncing(true);
    try { const r = await api.syncFeishu(); await reload(); toast(`已从飞书同步 ${r.imported} 条简历`); }
    catch (e) { toast("飞书同步失败:" + (e as Error).message); }
    setSyncing(false);
  };

  // 实时面试进度:进页面拉一次,之后每 20s 轮询(仅"面试中"候选人有数据)
  useEffect(() => {
    let alive = true;
    const pull = () => api.interviewsLive().then((r) => { if (alive) setLiveMap(r.live || {}); }).catch(() => undefined);
    pull();
    const t = setInterval(pull, 20000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const toggleStar = async (e: React.MouseEvent, c: any) => {
    e.stopPropagation();
    const next = !c.starred;
    setCandidates((xs) => xs.map((x) => (x.id === c.id ? { ...x, starred: next } : x))); // 乐观更新
    try { await api.setStar(c.id, next); }
    catch (err) { setCandidates((xs) => xs.map((x) => (x.id === c.id ? { ...x, starred: !next } : x))); toast("收藏失败:" + (err as Error).message); }
  };

  const cleanupStale = async () => {
    const ans = window.prompt("一键清理超时未响应:超过多少天仍未答题就清出流程?(状态清零为「已发链接未响应」,不删简历)", "2");
    if (ans == null) return;
    const days = Math.min(60, Math.max(1, Number(ans) || 2));
    setCleaning(true);
    try {
      const r = await api.cleanupStale(days);
      await reload();
      toast(r.count > 0 ? `已清理 ${r.count} 人(超 ${days} 天未响应):${r.cleared.map((x) => x.name).join("、")}` : `没有超过 ${days} 天未响应的候选人`);
    } catch (e) { toast("清理失败:" + (e as Error).message); }
    setCleaning(false);
  };

  const toggleSelect = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const openCompare = () => { setCompareResult(null); setCompareOpen(true); };
  const runCompare = async () => {
    // 只取仍存在于当前列表的候选人(避免已删除/已不在的陈旧 id)
    const ids = [...selected].filter((id) => candidates.some((c) => c.id === id));
    if (ids.length < 2) { toast("请至少选择 2 个仍在库中的候选人"); return; }
    setComparing(true); setCompareResult(null);
    try { const r = await api.compareCandidates(ids, compareFocus.trim()); setCompareResult({ ranking: r.ranking || [], summary: r.summary || "" }); }
    catch (e) { toast("对比失败:" + (e as Error).message); }
    setComparing(false);
  };

  const loadCats = (type: "normal" | "anchor") => api.collectionCategories(type).then((r) => setCollectCats(r.categories || [])).catch(() => undefined);
  const openCollect = () => { setCollectResult(null); setCollectForm({ name: "", role: "", type: "normal", focus: "" }); loadCats("normal"); setCollectOpen(true); };
  const setCollectType = (type: "normal" | "anchor") => { setCollectForm((f) => ({ ...f, type })); loadCats(type); };
  const createCollect = async () => {
    if (!collectForm.name.trim()) { toast("请先填候选人姓名"); return; }
    setCollectBusy(true);
    try {
      const r = await api.createCollection({ name: collectForm.name.trim(), role: collectForm.role.trim() || undefined, type: collectForm.type, focus: collectForm.focus.trim() || undefined, counts: collectCats });
      setCollectResult({ token: r.token, url: r.url, questions: r.questions });
      await reload();
    } catch (e) { toast("创建失败:" + (e as Error).message); }
    setCollectBusy(false);
  };
  const saveCollectQuestions = async () => {
    if (!collectResult) return;
    setCollectBusy(true);
    try { await api.updateCollectionQuestions(collectResult.token, collectResult.questions); toast("问题已保存"); }
    catch (e) { toast("保存失败:" + (e as Error).message); }
    setCollectBusy(false);
  };

  const [genning, setGenning] = useState(false);
  const needsReportCount = Object.values(liveMap).filter((l: any) => l && l.needsReport).length;
  const genMissingReports = async () => {
    if (!window.confirm(`为 ${needsReportCount} 名「已答完但还没出报告」的候选人补生成报告?\n会在后台逐个判题+整理+生成综合报告,稍等片刻后刷新即可看到。`)) return;
    setGenning(true);
    try { const r = await api.generateMissingReports(); toast(r.count > 0 ? `已开始为 ${r.count} 人补生成报告:${r.candidates.map((x) => x.name).join("、")},稍后刷新查看` : "没有待补生成报告的候选人"); }
    catch (e) { toast("补生成失败:" + (e as Error).message); }
    setGenning(false);
  };

  const isTopSchool = (c: any) => c.eduSchoolTier === "985" || c.eduSchoolTier === "211";
  // 双一流是更宽的"名校"口径:985/211 本身也是双一流,所以任意命中院校层次都算
  const isShuangyiliu = (c: any) => !!c.eduSchoolTier;
  // 本库可见范围:主库排除「不通过」(result=reject),不通过库只看它们。计数/下拉/筛选都基于这个范围。
  const scoped = useMemo(() => candidates.filter((c) => (rejected ? c.result === "reject" : c.result !== "reject")), [candidates, rejected]);
  const filtered = useMemo(() => {
    return scoped.filter((c) => {
      if (stage !== "all" && c.currentStage !== stage) return false;
      // 学校层次筛选:同时选了多个时取并集(985/211 或 双一流)
      if (fTopSchool || fShuangyiliu) {
        if (!((fTopSchool && isTopSchool(c)) || (fShuangyiliu && isShuangyiliu(c)))) return false;
      }
      if (roleFilter && c.positionId !== roleFilter) return false;
      if (fPostgrad && !c.eduPostgrad) return false;
      if (fLocal && !c.isLocal) return false;
      if (fStar && !c.starred) return false;
      if (q && !`${c.name}${c.bossName}${c.role}${c.eduSchoolName || ""}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [scoped, stage, roleFilter, q, fTopSchool, fShuangyiliu, fPostgrad, fLocal, fStar]);

  // 岗位下拉选项:本库实际出现的岗位(按系统匹配的标准岗位归并)
  const positions = useMemo(() => {
    const m = new Map<string, string>();
    scoped.forEach((c) => { if (c.positionId) m.set(c.positionId, c.positionRole || c.positionId); });
    return [...m.entries()].map(([id, role]) => ({ id, role, n: scoped.filter((c) => c.positionId === id).length }));
  }, [scoped]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const arr = [...filtered];
    arr.sort((a, b) => {
      const va = sortVal(a, sortKey), vb = sortVal(b, sortKey);
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "zh");
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const countByStage = (key: string) => scoped.filter((c) => c.currentStage === key).length;
  const topSchoolCount = scoped.filter(isTopSchool).length;
  const shuangyiliuCount = scoped.filter(isShuangyiliu).length;
  const postgradCount = scoped.filter((c) => c.eduPostgrad).length;
  const localCount = scoped.filter((c) => c.isLocal).length;
  const starCount = scoped.filter((c) => c.starred).length;

  return (
    <div>
      <div className="spread">
        <div>
          <h1 className="page-title">{rejected ? "不通过库" : "人才库"}</h1>
          <p className="page-sub">{rejected ? "已标记不通过的候选人 · 单独归档,不与在库的人混在一起" : "所有候选人走到哪一步了"} · 共 {scoped.length} 人</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {selected.size >= 1 && <button className="btn primary" onClick={openCompare} disabled={selected.size < 2} title="勾选 2 个及以上候选人,AI 综合对比并排序">⚖️ 对比已选 ({selected.size})</button>}
          {selected.size >= 1 && <button className="btn ghost" onClick={() => setSelected(new Set())}>清空选择</button>}
          <button className="btn" onClick={openCollect} title="给没有简历的社招候选人,生成一问一答的在线资料收集链接(主播岗含视频录入)">➕ 社招资料收集</button>
          {libUrl && <a className="btn" href={libUrl} target="_blank" rel="noreferrer" title="在飞书中打开系统读取简历的「简历库」多维表格">📄 飞书简历库 ↗</a>}
          {needsReportCount > 0 && <button className="btn primary" onClick={genMissingReports} disabled={genning} title="为已答完但还没出报告的候选人,后台批量补生成判题+整理+综合报告">{genning ? "补生成中…" : `📝 补生成报告 (${needsReportCount})`}</button>}
          <button className="btn" onClick={cleanupStale} disabled={cleaning} title="把已发链接、超时仍未答题的候选人状态清零为「已发链接未响应」(不删简历)">{cleaning ? "清理中…" : "🧹 清理超时未响应"}</button>
          <button className="btn" onClick={syncFeishu} disabled={syncing}>{syncing ? "同步中…" : "↻ 从飞书同步简历"}</button>
        </div>
      </div>

      <div className="filters">
        <label className="filter-field">岗位
          <select className="filter-select" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="">全部岗位 ({scoped.length})</option>
            {positions.map((p) => <option key={p.id} value={p.id}>{p.role} ({p.n})</option>)}
          </select>
        </label>
        <label className="filter-field">阶段
          <select className="filter-select" value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="all">全部阶段 ({scoped.length})</option>
            {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label} ({countByStage(s.key)})</option>)}
          </select>
        </label>
        <span className="chip-sep" />
        <span className={`chip edu-chip ${fTopSchool ? "active" : ""}`} onClick={() => setFTopSchool((v) => !v)}>🎓 985/211 {topSchoolCount}</span>
        <span className={`chip edu-chip ${fShuangyiliu ? "active" : ""}`} onClick={() => setFShuangyiliu((v) => !v)}>双一流 {shuangyiliuCount}</span>
        <span className={`chip edu-chip ${fPostgrad ? "active" : ""}`} onClick={() => setFPostgrad((v) => !v)}>硕士及以上 {postgradCount}</span>
        <span className={`chip local-chip ${fLocal ? "active" : ""}`} onClick={() => setFLocal((v) => !v)}>📍 徐州本地 {localCount}</span>
        <span className={`chip star-chip ${fStar ? "active" : ""}`} onClick={() => setFStar((v) => !v)}>⭐ 收藏 {starCount}</span>
        <input className="search" placeholder="搜索姓名/院校/简历…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: "auto" }} />
      </div>

      {loading ? <p className="muted">加载中…</p> : loadErr ? <div className="empty">加载失败:{loadErr} <a onClick={() => { setLoading(true); reload().catch(() => undefined).finally(() => setLoading(false)); }}>重试</a></div> : filtered.length === 0 ? <div className="empty">没有匹配的候选人</div> : (
        <table className="table">
          <thead><tr>
            <th title="勾选对比"></th>
            <th title="收藏">★</th>
            {SORT_COLS.map((col) => (
              <th key={col.key} className="sortable" onClick={() => clickSort(col.key)}>
                {col.label}{sortKey === col.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
              </th>
            ))}
            <th>面试进度</th>
            <th></th>
          </tr></thead>
          <tbody>
            {sorted.map((c) => {
              const m = stageMeta(c.currentStage);
              return (
                <tr key={c.id} className={selected.has(c.id) ? "row-selected" : ""} onClick={() => onOpenCandidate(c.id)}>
                  <td className="sel-cell" onClick={(e) => toggleSelect(e, c.id)}>
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => undefined} onClick={(e) => toggleSelect(e, c.id)} />
                  </td>
                  <td className="star-cell" onClick={(e) => toggleStar(e, c)} title={c.starred ? "取消收藏" : "收藏"}>
                    <span className={"star-toggle" + (c.starred ? " on" : "")}>{c.starred ? "★" : "☆"}</span>
                  </td>
                  <td><b>{c.name}</b>{c.isLocal && <span className="local-badge" title="期望/现居徐州">📍徐州</span>}{c.invitationStatus === "no_response" && <span className="noresp-badge" title="已发链接,超时未响应,已被清出流程">已发未响应</span>}</td>
                  <td className="muted" title={c.role !== c.positionRole ? `原始岗位:${c.role}` : undefined}>{c.positionRole || c.role}</td>
                  <td><EduCell c={c} /></td>
                  <td><span className="stage-dot" style={{ background: m.color }} />{m.label}</td>
                  <td><RatingCell c={c} /></td>
                  <td className="muted small">{c.source}</td>
                  <td className="muted small">{c.collectedDate || (c.createdAt || "").slice(0, 10) || "—"}</td>
                  <td><LiveCell live={liveMap[c.id]} stage={c.currentStage} /></td>
                  <td><button className="btn sm" style={{ color: "var(--bad)", borderColor: "rgba(255,90,90,.4)" }} onClick={(e) => del(e, c)}>删除</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {collectOpen && (
        // 只有在遮罩本身按下鼠标才关闭;在输入框里拖选文字、鼠标松开落到遮罩上不会误关
        <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setCollectOpen(false); }}>
          <div className="modal compare-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="spread" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>新建社招资料收集</h2>
              <a onClick={() => setCollectOpen(false)}>关闭 ✕</a>
            </div>
            {!collectResult ? (
              <>
                <p className="muted small" style={{ marginTop: 0 }}>给没有简历的社招候选人,AI 按岗位生成一问一答的在线收集问题,生成链接发给对方填写。主播岗会额外加一段对镜头的视频录入。</p>
                <label>候选人姓名 *</label>
                <input value={collectForm.name} onChange={(e) => setCollectForm((f) => ({ ...f, name: e.target.value }))} placeholder="如:张三" />
                <label>应聘岗位</label>
                <input value={collectForm.role} onChange={(e) => setCollectForm((f) => ({ ...f, role: e.target.value }))} placeholder="如:AI应用工程师 / 主播 / 运营" />
                <label>岗位类型</label>
                <div className="row" style={{ gap: 8 }}>
                  <button className={"btn " + (collectForm.type === "normal" ? "primary" : "")} onClick={() => setCollectType("normal")}>普通社招(纯文字)</button>
                  <button className={"btn " + (collectForm.type === "anchor" ? "primary" : "")} onClick={() => setCollectType("anchor")}>🎬 主播岗(含视频录入)</button>
                </div>
                <label>每类题目数量(已按岗位类型预填,可调)</label>
                <div className="muted small" style={{ margin: "0 0 6px", lineHeight: 1.6 }}>
                  基本资料用表格直接收集,不在此处出题。下面是口述{collectForm.type === "anchor" ? "/视频" : ""}题的考察类别与题数,改成 0 表示该类不出题。
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {collectCats.map((c, i) => (
                    <div key={c.key} className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                      <span className="small">{c.name}</span>
                      <input type="number" min={0} max={8} value={c.n} style={{ width: 64 }}
                        onChange={(e) => setCollectCats((cs) => cs.map((x, j) => j === i ? { ...x, n: Math.max(0, Math.min(8, Number(e.target.value) || 0)) } : x))} />
                    </div>
                  ))}
                  <div className="muted small">共 {collectCats.reduce((s, c) => s + c.n, 0)} 题{collectForm.type === "anchor" ? " · 另有综合评定" : ""}</div>
                </div>
                <label>侧重 / 备注(可选)</label>
                <input value={collectForm.focus} onChange={(e) => setCollectForm((f) => ({ ...f, focus: e.target.value }))} placeholder="如:重点了解直播带货经验" />
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn primary" onClick={createCollect} disabled={collectBusy}>{collectBusy ? "生成中…(AI 出题)" : "生成问题 + 链接"}</button>
                </div>
              </>
            ) : (
              <>
                <div className="saved-badge" style={{ marginBottom: 10 }}>✓ 已创建,候选人已进入人才库(社招·资料收集中)</div>
                <label>收集链接(发给候选人)</label>
                <div className="invite-box small">{location.origin}{collectResult.url}</div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn primary" onClick={() => copyText(`${location.origin}${collectResult.url}`).then((ok) => toast(ok ? "链接已复制,发给候选人" : "复制失败,请手动复制"))}>复制链接</button>
                  <a className="btn ghost" href={collectResult.url} target="_blank" rel="noreferrer">预览</a>
                </div>
                <label style={{ marginTop: 14 }}>AI 生成的问题(按类别归类,可改,改完点保存)</label>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {collectResult.questions.map((q, i) => (
                    <div key={q.id || i} className="row" style={{ gap: 6, alignItems: "flex-start" }}>
                      {q.category && <span className="noresp-badge" style={{ minWidth: 70, textAlign: "center", margin: "6px 0 0" }}>{q.category}</span>}
                      <textarea value={q.q} rows={2} style={{ flex: 1, minHeight: 56, resize: "vertical", lineHeight: 1.6 }} onChange={(e) => setCollectResult((r) => r ? { ...r, questions: r.questions.map((x, j) => j === i ? { ...x, q: e.target.value } : x) } : r)} />
                    </div>
                  ))}
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn primary" onClick={saveCollectQuestions} disabled={collectBusy}>{collectBusy ? "保存中…" : "保存问题修改"}</button>
                  <button className="btn ghost" onClick={() => setCollectOpen(false)}>完成</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {compareOpen && (
        <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setCompareOpen(false); }}>
          <div className="modal compare-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="spread" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>人才对比 · 已选 {selected.size} 人</h2>
              <a onClick={() => setCompareOpen(false)}>关闭 ✕</a>
            </div>
            <p className="muted small" style={{ marginTop: 0 }}>从「简历综合 / 回答表现 / 综合素质」三维度横向对比,按你的需求排序并给推荐理由。没完成面试的候选人只就简历评。</p>
            <label style={{ marginTop: 6 }}>当前需求 / 对比侧重(可留空,留空按岗位画像)</label>
            <textarea style={{ minHeight: 60 }} placeholder="例如:优先 AI 落地能力强 + 能接受徐州现场 + 表达好适合出镜;或留空让 AI 按岗位综合排序" value={compareFocus} onChange={(e) => setCompareFocus(e.target.value)} />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary" onClick={runCompare} disabled={comparing || selected.size < 2}>{comparing ? "对比中…(约 20-40s)" : "开始对比"}</button>
            </div>

            {compareResult && (
              <div style={{ marginTop: 16 }}>
                {compareResult.summary && <div className="compare-summary">🧭 {compareResult.summary}</div>}
                <div className="compare-rank">
                  {compareResult.ranking.map((r) => (
                    <div className="compare-card" key={r.id} onClick={() => { setCompareOpen(false); onOpenCandidate(r.id); }}>
                      <div className="compare-card-head">
                        <span className={"rank-no rank-" + (r.rank <= 3 ? r.rank : "x")}>{r.rank}</span>
                        <b className="compare-name">{r.name}</b>
                        {typeof r.score === "number" && r.score > 0 && <span className="compare-score">综合 {r.score}</span>}
                        <span className="muted small compare-oneline">{r.oneLine}</span>
                      </div>
                      {r.dims && (r.dims.resume > 0 || r.dims.interview > 0 || r.dims.quality > 0) && (
                        <div className="compare-dims">
                          <span>简历 <b>{r.dims.resume}</b></span><span>回答 <b>{r.dims.interview}</b></span><span>素质 <b>{r.dims.quality}</b></span>
                        </div>
                      )}
                      <div className="compare-reason">{r.reason}</div>
                    </div>
                  ))}
                </div>
                <p className="muted small" style={{ marginTop: 8 }}>点候选人卡片可直接打开其详情。结论仅供参考,二面请人工复核。</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 面试进度列:已发起面试的候选人,显示链接是否被打开、是否在线、在答第几题(20s 轮询刷新)
function LiveCell({ live, stage }: { live: any; stage: string }) {
  if (stage !== "interviewing") return <span className="muted small">—</span>;
  if (!live) return <span className="muted small">—</span>;
  if (live.needsReport) return <span className="live-pill report" title="候选人已答完但还没生成报告,点上方「📝 补生成报告」">⚠ 待生成报告</span>;
  if (live.status === "completed") return <span className="live-pill done">✓ 已提交</span>;
  if (live.gate === "locked" || live.status === "terminated") return <span className="live-pill ended">已结束/超时</span>;
  if (live.step === 0) return <span className="live-pill wait">未打开链接</span>;
  // 已打开:在线/离线 + 当前步骤
  return (
    <span className={"live-pill " + (live.online ? "on" : "off")}>
      <span className="live-dot" />{live.online ? "在线" : "离线"} · {live.stepLabel}
    </span>
  );
}

// 学历列:院校层次(985/211/双一流)+ 学历(硕士/博士高亮;本科/大专淡显)。识别不到显示 —
function EduCell({ c }: { c: any }) {
  const tier = c.eduSchoolTier as string | undefined;
  const deg = c.eduDegree as string | undefined;
  if (!tier && !deg) return <span className="muted small">—</span>;
  return (
    <span className="edu-cell" title={c.eduSchoolName || ""}>
      {tier === "985" && <span className="edu-badge b985">985</span>}
      {tier === "211" && <span className="edu-badge b211">211</span>}
      {tier === "双一流" && <span className="edu-badge bsyl">双一流</span>}
      {(deg === "硕士" || deg === "博士") && <span className="edu-badge bdeg">{deg}</span>}
      {(deg === "本科" || deg === "大专") && <span className="muted small">{deg}</span>}
    </span>
  );
}

// ── 列排序 ──
const SORT_COLS: Array<{ key: string; label: string }> = [
  { key: "name", label: "姓名" }, { key: "role", label: "岗位" }, { key: "edu", label: "学历" },
  { key: "stage", label: "阶段" }, { key: "rating", label: "评级 / 结果" }, { key: "source", label: "来源" }, { key: "date", label: "收录日期" },
];
const STAGE_ORDER = STAGES.map((s) => s.key); // 阶段排序顺序,直接派生自 STAGES 保持一致
function eduRank(c: any): number {
  const t = ({ "985": 3, "211": 2, "双一流": 1 } as any)[c.eduSchoolTier] || 0;
  const d = ({ "博士": 4, "硕士": 3, "本科": 2, "大专": 1 } as any)[c.eduDegree] || 0;
  return t * 10 + d;
}
function ratingRank(c: any): number {
  if (c.result === "pass") return 100;
  if (c.result === "reject") return 5;
  const g = ({ "A": 90, "A-": 85, "B+": 80, "B": 75, "C+": 70, "C": 60, "D": 40 } as any)[c.priority];
  if (g != null) return g;
  const s = ({ "推荐": 50, "待定": 30, "不推荐": 10 } as any)[c.screeningRating];
  if (s != null) return s;
  return 0;
}
function sortVal(c: any, key: string): string | number {
  switch (key) {
    case "name": return c.name || "";
    case "role": return c.positionRole || c.role || "";
    case "edu": return eduRank(c);
    case "stage": { const i = STAGE_ORDER.indexOf(c.currentStage); return i < 0 ? -1 : i; }
    case "rating": return ratingRank(c);
    case "source": return c.source || "";
    case "date": return c.collectedDate || (c.createdAt || "").slice(0, 10) || "";
    default: return "";
  }
}

// 评级/结果列:已决定→通过/不通过;已出面试报告→等级 A/B/C/D;只初筛过→初筛评级;都没有→—
function RatingCell({ c }: { c: any }) {
  if (c.result === "pass") return <span className="rating 推荐">已通过</span>;
  if (c.result === "reject") return <span className="rating 不推荐">不通过</span>;
  if (c.priority) return <span className="grade B">{c.priority}</span>;
  if (c.screeningRating) return <span className={`rating ${c.screeningRating}`}>{c.screeningRating}<span className="muted small" style={{ marginLeft: 4 }}>初筛</span></span>;
  return <span className="muted small">—</span>;
}
