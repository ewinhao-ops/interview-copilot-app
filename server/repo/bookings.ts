// 二面预约 / 开放档期 / 预约链接 仓库。
// 预约与档期对前端保真:raw 列存完整对象,读出时直接返回 raw 合并必要字段。
import { getDb, fromJson, toJson, nowIso } from "../db.js";

// ── bookings ──
export function listBookings() {
  const rows = getDb().prepare("SELECT raw FROM bookings ORDER BY created_at DESC").all() as { raw: string }[];
  return rows.map((r) => fromJson<Record<string, unknown>>(r.raw, {}));
}

export function getBooking(id: string) {
  const row = getDb().prepare("SELECT raw FROM bookings WHERE id = ?").get(id) as { raw: string } | undefined;
  return row ? fromJson<Record<string, unknown>>(row.raw, {}) : null;
}

export function upsertBooking(booking: Record<string, any>) {
  const db = getDb();
  const now = nowIso();
  const existing = db.prepare("SELECT created_at FROM bookings WHERE id = ?").get(booking.id) as { created_at: string } | undefined;
  const slot = (booking.slot || {}) as Record<string, unknown>;
  db.prepare(
    `INSERT INTO bookings (
       id, candidate_id, candidate_name, token, room_token, matched_resume_id,
       slot_date, slot_start, slot_end, review_status, submitted_at, reviewed_at, raw, created_at, updated_at
     ) VALUES (
       @id, @candidate_id, @candidate_name, @token, @room_token, @matched_resume_id,
       @slot_date, @slot_start, @slot_end, @review_status, @submitted_at, @reviewed_at, @raw, @created_at, @updated_at
     )
     ON CONFLICT(id) DO UPDATE SET
       candidate_id=excluded.candidate_id, candidate_name=excluded.candidate_name, token=excluded.token,
       room_token=excluded.room_token, matched_resume_id=excluded.matched_resume_id,
       slot_date=excluded.slot_date, slot_start=excluded.slot_start, slot_end=excluded.slot_end,
       review_status=excluded.review_status, submitted_at=excluded.submitted_at,
       reviewed_at=excluded.reviewed_at, raw=excluded.raw, updated_at=excluded.updated_at`
  ).run({
    id: booking.id,
    candidate_id: booking.candidateId ?? null,
    candidate_name: booking.candidateName ?? null,
    token: booking.token ?? null,
    room_token: booking.roomToken ?? null,
    matched_resume_id: booking.matchedResumeId ?? null,
    slot_date: slot.date ?? null,
    slot_start: slot.start ?? null,
    slot_end: slot.end ?? null,
    review_status: booking.reviewStatus ?? "pending",
    submitted_at: booking.submittedAt ?? now,
    reviewed_at: booking.reviewedAt ?? null,
    raw: toJson(booking),
    created_at: existing?.created_at ?? booking.createdAt ?? now,
    updated_at: now,
  });
  return getBooking(booking.id);
}

export function reviewBooking(id: string, reviewStatus: string) {
  const booking = getBooking(id) as Record<string, any> | null;
  if (!booking) return null;
  return upsertBooking({ ...booking, reviewStatus, reviewedAt: nowIso() });
}

// ── availability ranges ──
export function listAvailability() {
  const rows = getDb().prepare("SELECT raw FROM availability").all() as { raw: string }[];
  return rows.map((r) => fromJson<Record<string, unknown>>(r.raw, {}));
}

/** 整体覆盖式写入(对应旧 POST /api/availability-ranges)。 */
export function replaceAvailability(ranges: Array<Record<string, any>>) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM availability").run();
    const ins = db.prepare(
      "INSERT INTO availability (id, date, start, end, status, raw) VALUES (@id, @date, @start, @end, @status, @raw)"
    );
    ranges.forEach((r, i) => {
      ins.run({
        id: r.id ?? `range-${i}-${crypto.randomUUID()}`,
        date: r.date ?? null,
        start: r.start ?? null,
        end: r.end ?? null,
        status: r.status ?? "open",
        raw: toJson(r),
      });
    });
  });
  tx();
  return listAvailability();
}

// ── booking links ──
export function getBookingLink(token: string) {
  const row = getDb().prepare("SELECT config FROM booking_links WHERE token = ?").get(token) as { config: string } | undefined;
  return row ? fromJson<Record<string, unknown>>(row.config, {}) : null;
}

export function saveBookingLink(token: string, config: Record<string, unknown>) {
  getDb()
    .prepare(
      `INSERT INTO booking_links (token, config, created_at) VALUES (?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET config = excluded.config`
    )
    .run(token, toJson(config), nowIso());
}

export function withLiveRanges(link: Record<string, unknown> | null) {
  if (!link) return link;
  return { ...link, ranges: listAvailability() };
}

// ── 按候选人的二面邀约(每个人专属档期,非全局) ──
export function findSecondInviteByCandidate(candidateId: string): { token: string; config: any } | null {
  const rows = getDb().prepare("SELECT token, config FROM booking_links ORDER BY created_at DESC").all() as { token: string; config: string }[];
  for (const r of rows) {
    const cfg = fromJson<any>(r.config, {});
    if (cfg.purpose === "second-interview" && cfg.candidateId === candidateId) return { token: r.token, config: cfg };
  }
  return null;
}

/** 按候选人找其社招资料收集链接(purpose=resume-collection)。 */
export function findCollectionByCandidate(candidateId: string): { token: string; config: any } | null {
  const rows = getDb().prepare("SELECT token, config FROM booking_links ORDER BY created_at DESC").all() as { token: string; config: string }[];
  for (const r of rows) {
    const cfg = fromJson<any>(r.config, {});
    if (cfg.purpose === "resume-collection" && cfg.candidateId === candidateId) return { token: r.token, config: cfg };
  }
  return null;
}

export function findBookingByCandidate(candidateId: string) {
  const rows = getDb().prepare("SELECT raw FROM bookings ORDER BY created_at DESC").all() as { raw: string }[];
  for (const r of rows) {
    const b = fromJson<any>(r.raw, {});
    if (b.candidateId === candidateId) return b;
  }
  return null;
}

/** 已被占用的二面时段(date/start/end)。可排除某候选人自己;reviewStatus=rejected/cancelled 视为已释放。 */
export function listBookedSlots(exceptCandidateId?: string): Array<{ date: string; start: string; end: string; candidateName?: string }> {
  const rows = getDb().prepare("SELECT raw FROM bookings").all() as { raw: string }[];
  const out: Array<{ date: string; start: string; end: string; candidateName?: string }> = [];
  for (const r of rows) {
    const b = fromJson<any>(r.raw, {});
    if (exceptCandidateId && b.candidateId === exceptCandidateId) continue;
    if (b.reviewStatus === "rejected" || b.reviewStatus === "cancelled") continue;
    const s = b.slot || {};
    if (s.date && s.start) out.push({ date: s.date, start: s.start, end: s.end || s.start, candidateName: b.candidateName });
  }
  return out;
}
