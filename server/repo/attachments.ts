// 候选人附件仓库:答题图片(data_url 内联)+ 作品集(kind='portfolio',图片/视频落盘,file_path 指向磁盘)。
import { getDb, nowIso } from "../db.js";

export interface AttachmentRow {
  id: string;
  interview_id: string;
  question_id: string | null;
  kind: string;
  name: string | null;
  data_url: string | null;
  file_path: string | null;
  mime: string | null;
  size: number | null;
  created_at: string | null;
}

export function addAttachment(opts: {
  interviewId: string;
  questionId?: string;
  name?: string;
  dataUrl?: string;
  filePath?: string;
  mime?: string;
  size?: number;
  kind?: string;
}) {
  const db = getDb();
  const id = `att-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO interview_attachments (id, interview_id, question_id, kind, name, data_url, file_path, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, opts.interviewId, opts.questionId ?? null, opts.kind ?? "answer_image",
    opts.name ?? null, opts.dataUrl ?? null, opts.filePath ?? null, opts.mime ?? null, opts.size ?? null, nowIso(),
  );
  return id;
}

export function countByInterview(interviewId: string): number {
  const r = getDb().prepare("SELECT count(*) c FROM interview_attachments WHERE interview_id = ?").get(interviewId) as { c: number };
  return r?.c ?? 0;
}

export function countByKind(interviewId: string, kind: string): number {
  const r = getDb().prepare("SELECT count(*) c FROM interview_attachments WHERE interview_id = ? AND kind = ?").get(interviewId, kind) as { c: number };
  return r?.c ?? 0;
}

export function getAttachment(id: string): AttachmentRow | undefined {
  return getDb().prepare("SELECT * FROM interview_attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
}

export function deleteAttachment(id: string): void {
  getDb().prepare("DELETE FROM interview_attachments WHERE id = ?").run(id);
}

/** 判断附件类型(image / video / file),供前端选渲染方式。 */
function attachmentType(r: { kind: string; mime: string | null; data_url: string | null }): "image" | "video" | "file" {
  const m = (r.mime || "").toLowerCase();
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("image/")) return "image";
  if ((r.data_url || "").startsWith("data:image/")) return "image";
  return "file";
}

/** 元数据列表(不含 data_url/文件内容,载荷轻),给后台/候选人列出附件用。 */
export function listMeta(interviewId: string) {
  return (getDb()
    .prepare("SELECT id, question_id, kind, name, mime, size, file_path, data_url, created_at FROM interview_attachments WHERE interview_id = ? ORDER BY created_at ASC")
    .all(interviewId) as AttachmentRow[]).map((r) => ({
    id: r.id,
    questionId: r.question_id || undefined,
    kind: r.kind,
    name: r.name || undefined,
    mime: r.mime || undefined,
    size: r.size || undefined,
    type: attachmentType(r),
    createdAt: r.created_at,
  }));
}

/** 全量(含 data_url),旧接口保留。 */
export function listByInterview(interviewId: string) {
  return (getDb()
    .prepare("SELECT id, question_id, kind, name, data_url, file_path, mime, size, created_at FROM interview_attachments WHERE interview_id = ? ORDER BY created_at ASC")
    .all(interviewId) as AttachmentRow[]).map((r) => ({
    id: r.id, questionId: r.question_id || undefined, kind: r.kind, name: r.name || undefined,
    dataUrl: r.data_url || undefined, filePath: r.file_path || undefined, mime: r.mime || undefined,
    size: r.size || undefined, createdAt: r.created_at,
  }));
}
