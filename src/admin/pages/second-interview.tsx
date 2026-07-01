// 二面:在日历上圈选时间段,生成该候选人专属预约链接;看候选人挑了哪个并确认。
import React, { useEffect, useMemo, useState } from "react";
import { api, copyText } from "../api.js";

const HOURS = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00"];
const WEEKDAY = "日一二三四五六";
const pad = (n: number) => String(n).padStart(2, "0");
const fmtDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addMin = (hhmm: string, min: number) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = h * 60 + m + min;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
};

// 日历圈选:7 天 × 小时,点格子选/取消;返回 {date,start,end}[]
function SlotCalendar({ value, onChange, booked }: { value: any[]; onChange: (s: any[]) => void; booked?: Array<{ date: string; start: string; end: string }> }) {
  const isBooked = (ds: string, h: string) => (booked || []).some((b) => b.date === ds && h < (b.end || b.start) && b.start < addMin(h, 30));
  const [weekOffset, setWeekOffset] = useState(0);
  const days = useMemo(() => {
    const base = new Date(); base.setHours(0, 0, 0, 0); base.setDate(base.getDate() + weekOffset * 7);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(base); d.setDate(base.getDate() + i); return d; });
  }, [weekOffset]);
  const sel = new Set(value.map((s) => `${s.date}|${s.start}`));
  const toggle = (date: string, start: string) => {
    const key = `${date}|${start}`;
    if (sel.has(key)) onChange(value.filter((s) => `${s.date}|${s.start}` !== key));
    else onChange([...value, { date, start, end: addMin(start, 30) }].sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`)));
  };
  const today = fmtDate(new Date());
  return (
    <div className="cal">
      <div className="cal-nav">
        <button className="btn sm" onClick={() => setWeekOffset((w) => Math.max(0, w - 1))} disabled={weekOffset === 0}>← 上周</button>
        <span className="muted small">{fmtDate(days[0]).slice(5)} ~ {fmtDate(days[6]).slice(5)}</span>
        <button className="btn sm" onClick={() => setWeekOffset((w) => w + 1)}>下周 →</button>
      </div>
      <div className="cal-grid">
        <div className="cal-corner" />
        {days.map((d) => {
          const ds = fmtDate(d);
          return <div key={ds} className={`cal-day ${ds === today ? "is-today" : ""}`}>{`${d.getMonth() + 1}/${d.getDate()}`}<div className="cal-wd">周{WEEKDAY[d.getDay()]}</div></div>;
        })}
        {HOURS.map((h) => (
          <React.Fragment key={h}>
            <div className="cal-time">{h}</div>
            {days.map((d) => {
              const ds = fmtDate(d);
              const past = ds < today;
              const on = sel.has(`${ds}|${h}`);
              const taken = !on && isBooked(ds, h);
              return <div key={ds + h} className={`cal-cell ${on ? "on" : ""} ${past ? "past" : ""} ${taken ? "taken" : ""}`} title={taken ? "该时段已被占用(其他候选人二面 / 你在日历里的安排)" : undefined} onClick={() => !past && !taken && toggle(ds, h)} />;
            })}
          </React.Fragment>
        ))}
      </div>
      <p className="muted small">已圈选 {value.length} 个时间(每个 30 分钟)。点格子选/取消。{(booked && booked.length) ? <span className="bad"> 灰色格子=已被其他候选人预约,不可选。</span> : null}</p>
    </div>
  );
}

export function SecondInterviewPanel({ candidateId, toast, initial }: { candidateId: string; toast: (m: string) => void; initial?: { invite: any; booking: any } | null }) {
  const [data, setData] = useState<{ invite: any; booking: any; bookedSlots?: any[] } | null>(initial ?? null);
  const [picking, setPicking] = useState(false);
  const [slots, setSlots] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  const load = () => api.secondInterview(candidateId).then(setData);
  // 详情页已通过 initial 传入,无需再单独请求;未传时(独立使用)才自取
  useEffect(() => { if (initial === undefined) load(); /* eslint-disable-next-line */ }, [candidateId]);
  useEffect(() => { if (initial !== undefined) setData(initial); }, [initial]);

  const generate = async () => {
    if (!slots.length) { toast("先在日历上圈选时间"); return; }
    setBusy(true);
    try { await api.secondInvite(candidateId, slots); setPicking(false); setSlots([]); toast("二面邀约链接已生成"); await load(); }
    catch (e) { toast("失败:" + (e as Error).message); }
    setBusy(false);
  };
  const confirm = async (bookingId: string) => {
    try { await api.reviewBooking(bookingId, "approved"); toast("已确认二面时间"); await load(); }
    catch (e) { toast("失败:" + (e as Error).message); }
  };

  if (!data) return <span className="muted small">加载中…</span>;
  const { invite, booking } = data;
  const url = invite ? location.origin + invite.url : "";

  // 已生成邀约
  if (invite) {
    const picked = invite.pickedIndex != null ? invite.slots[invite.pickedIndex] : null;
    const confirmed = booking && booking.reviewStatus === "approved";
    return (
      <div>
        {confirmed ? (
          <div className="small ok">✓ 已确认二面:{booking.slot?.date} {booking.slot?.start}-{booking.slot?.end}</div>
        ) : picked ? (
          <div>
            <div className="small">候选人已选:<b>{picked.date} {picked.start}-{picked.end}</b></div>
            <button className="btn primary sm" style={{ marginTop: 6 }} onClick={() => confirm(booking?.id || `bk-${candidateId}`)}>确认这个时间</button>
          </div>
        ) : (
          <div>
            <div className="small muted">已发邀约,等候选人挑时间。给了 {invite.slots?.length} 个可选时段。</div>
            <div className="invite-box small" style={{ marginTop: 6 }}>{url}</div>
            <button className="btn sm" style={{ marginTop: 6 }} onClick={() => copyText(url).then((ok) => toast(ok ? "链接已复制" : "复制失败,请手动复制上面的链接"))}>复制链接发微信</button>
          </div>
        )}
        <a className="small" style={{ display: "inline-block", marginTop: 8 }} onClick={() => { setPicking(!picking); setSlots(invite.slots || []); }}>{picking ? "收起" : "重新圈选时间"}</a>
        {picking && <div style={{ marginTop: 8 }}><SlotCalendar value={slots} onChange={setSlots} booked={data?.bookedSlots} /><button className="btn primary sm" onClick={generate} disabled={busy}>{busy ? "生成中…" : "更新邀约链接"}</button></div>}
      </div>
    );
  }

  // 还没约
  return (
    <div>
      {!picking ? (
        <button className="btn primary sm" onClick={() => setPicking(true)}>约二面 · 圈选时间</button>
      ) : (
        <div>
          <SlotCalendar value={slots} onChange={setSlots} booked={data?.bookedSlots} />
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn primary sm" onClick={generate} disabled={busy}>{busy ? "生成中…" : "生成二面邀约链接"}</button>
            <button className="btn ghost sm" onClick={() => { setPicking(false); setSlots([]); }}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
