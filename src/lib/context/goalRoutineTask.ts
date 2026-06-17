import type { TaskKind } from "../../types/engine";

interface RoutineItem {
  id: number;
  content: string;
  frequency: string;
  time: string;
  duration: number;
}

interface SubTaskItem {
  id: number;
  done: boolean;
  content: string;
  duration: number;
}

interface TaskItem {
  id: number;
  done: boolean;
  content: string;
  notes?: string;
  priority: string;
  duration: number;
  deadline: string;
  subtasks: SubTaskItem[];
}

function loadRoutines(): RoutineItem[] {
  try {
    const raw = localStorage.getItem("pc-routines");
    return raw ? (JSON.parse(raw) as RoutineItem[]) : [];
  } catch {
    return [];
  }
}

function loadTasks(): TaskItem[] {
  try {
    const raw = localStorage.getItem("pc-tasks");
    return raw ? (JSON.parse(raw) as TaskItem[]) : [];
  } catch {
    return [];
  }
}

function formatRoutine(r: RoutineItem): string {
  return `- id:${r.id} content:"${(r.content || "").replace(/"/g, '\\"')}" frequency:${r.frequency || "—"} time:${r.time || "—"} duration:${r.duration ?? 0}m`;
}

function formatTask(t: TaskItem): string {
  const done = t.done ? " [done]" : "";
  const notes = t.notes ? ` notes:"${(t.notes || "").replace(/"/g, '\\"').slice(0, 80)}"` : "";
  return `- id:${t.id} content:"${(t.content || "").replace(/"/g, '\\"')}" priority:${t.priority || "—"} deadline:${t.deadline || "—"}${notes}${done}`;
}

/**
 * Load Routine and Tasks from localStorage and format for LLM context.
 * Only returns content when taskKinds includes schedule, task, or timer.
 */
export function loadGoalRoutineTaskContext(taskKinds: TaskKind[]): string {
  const needsContext =
    taskKinds.includes("schedule") ||
    taskKinds.includes("task") ||
    taskKinds.includes("timer");

  if (!needsContext) return "";

  const routines = loadRoutines();
  const tasks = loadTasks();

  const sections: string[] = [];

  if (routines.length > 0) {
    sections.push(`[Routines]\n${routines.map(formatRoutine).join("\n")}`);
  }
  if (tasks.length > 0) {
    sections.push(`[Tasks]\n${tasks.map(formatTask).join("\n")}`);
  }

  return sections.length > 0 ? sections.join("\n\n") + "\n" : "";
}
