import type { ProjectProgress } from "@/domain/project/tracking";
import { progressLabel } from "./project-tracking-display";

export function ProjectProgress({ value, title }: { value: ProjectProgress; title?: string }) {
  return <div className="project-progress">
    <p>{title && <span>{title}</span>}<strong>{progressLabel(value)}</strong></p>
    {value !== null && <progress value={value} max={100} aria-label={title ?? "프로젝트 진행률"}>{value}%</progress>}
  </div>;
}
