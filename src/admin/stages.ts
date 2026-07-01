export const STAGES = [
  { key: "intake", label: "入库", color: "#9aa0aa" },
  { key: "screened", label: "已初筛", color: "#4f8cff" },
  { key: "interviewing", label: "一面中", color: "#ffb020" },
  { key: "reviewed", label: "待决定", color: "#e0703a" },
  { key: "second_invited", label: "约二面中", color: "#b07bff" },
  { key: "second_picked", label: "二面待确认", color: "#9a5cff" },
  { key: "second_confirmed", label: "二面已确认", color: "#7c4dff" },
  { key: "result", label: "已出结果", color: "#34c77b" },
] as const;

export function stageMeta(key: string) {
  return STAGES.find((s) => s.key === key) || STAGES[0];
}
