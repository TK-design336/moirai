import { invoke } from "@tauri-apps/api/core";
import { getValidGoogleToken } from "../googleAuth";

const TASKS_API = "https://tasks.googleapis.com/tasks/v1";

async function fetchProxy(
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
): Promise<string> {
  try {
    return await invoke<string>("fetch_proxy", { req: { url, method, headers, body: body ?? null } });
  } catch {
    const resp = await fetch(url, { method, headers, body });
    return resp.text();
  }
}

async function getToken(): Promise<string | null> {
  return getValidGoogleToken();
}

export interface GoogleTaskList {
  id: string;
  title: string;
}

export interface GoogleTask {
  id: string;
  title: string;
  notes?: string;
  due?: string; // RFC 3339
  status: "needsAction" | "completed";
  completed?: string; // RFC 3339 when completed
  updated?: string; // RFC 3339
  parent?: string; // for subtasks
}

/** Normalized app task shape (title, notes, due_date, completed, subtasks) */
export interface AppTask {
  id: string;
  title: string;
  notes?: string;
  due_date?: string; // YYYY-MM-DD or YYYY-MM-DDTHH:mm
  completed: boolean;
  subtasks: { id: string; title: string; done: boolean }[];
  /** Google API updated timestamp for merge decisions */
  updated?: string;
  /** Google task id for API operations */
  googleId?: string;
}

function toAppTask(t: GoogleTask, subtasks: GoogleTask[] = []): AppTask {
  const dueDate = t.due ? t.due.slice(0, 10) : undefined;
  return {
    id: t.id,
    googleId: t.id,
    title: t.title || "(untitled)",
    notes: t.notes || undefined,
    due_date: dueDate,
    completed: t.status === "completed",
    updated: t.updated,
    subtasks: subtasks.map((s) => ({
      id: s.id,
      title: s.title || "",
      done: s.status === "completed",
    })),
  };
}

export async function taskListsList(): Promise<GoogleTaskList[]> {
  const token = await getToken();
  if (!token) return [];

  const raw = await fetchProxy(
    `${TASKS_API}/users/@me/lists`,
    "GET",
    { Authorization: `Bearer ${token}` },
  );
  const data = JSON.parse(raw) as { error?: { message?: string; code?: number }; items?: Array<{ id: string; title?: string }> };
  if (data.error) {
    const msg = data.error.message ?? "Unknown error";
    throw new Error(data.error.code === 403 ? `スコープ不足: ${msg}` : msg);
  }
  return (data.items ?? []).map((i) => ({
    id: i.id,
    title: i.title ?? "Tasks",
  }));
}

export interface TasksListResult {
  ok: boolean;
  tasks: AppTask[];
  error?: string;
}

export async function tasksList(
  taskListId: string,
  opts?: { dueMin?: string; dueMax?: string; showCompleted?: boolean },
): Promise<AppTask[]> {
  const r = await tasksListWithStatus(taskListId, opts);
  return r.tasks;
}

export async function tasksListWithStatus(
  taskListId: string,
  opts?: { dueMin?: string; dueMax?: string; showCompleted?: boolean },
): Promise<TasksListResult> {
  const token = await getToken();
  if (!token) return { ok: false, tasks: [], error: "no_token" };

  try {
    const params = new URLSearchParams();
    params.set("maxResults", "100");
    if (opts?.showCompleted !== false) params.set("showCompleted", "true");
    if (opts?.showCompleted === false) params.set("showCompleted", "false");
    if (opts?.dueMin) params.set("dueMin", opts.dueMin);
    if (opts?.dueMax) params.set("dueMax", opts.dueMax);
    params.set("showHidden", "false");

    const raw = await fetchProxy(
      `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks?${params}`,
      "GET",
      { Authorization: `Bearer ${token}` },
    );
    const data = JSON.parse(raw);
    if (data.error) {
      return { ok: false, tasks: [], error: data.error.message ?? "api_error" };
    }

    const items = (data.items ?? []) as GoogleTask[];
    const topLevel = items.filter((t) => !t.parent);
    const byParent = new Map<string, GoogleTask[]>();
    for (const t of items) {
      if (t.parent) {
        const list = byParent.get(t.parent) ?? [];
        list.push(t);
        byParent.set(t.parent, list);
      }
    }

    return { ok: true, tasks: topLevel.map((t) => toAppTask(t, byParent.get(t.id) ?? [])) };
  } catch (e) {
    return { ok: false, tasks: [], error: String(e) };
  }
}

export async function taskInsert(
  taskListId: string,
  task: { title: string; notes?: string; due?: string; completed?: boolean; parent?: string },
): Promise<{ id: string; updated?: string } | null> {
  const token = await getToken();
  if (!token) return null;

  const body: Record<string, unknown> = {
    title: task.title,
    status: task.completed ? "completed" : "needsAction",
  };
  if (task.notes) body.notes = task.notes;
  if (task.due) body.due = task.due;
  if (task.parent) body.parent = task.parent;

  try {
    const raw = await fetchProxy(
      `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks`,
      "POST",
      {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      JSON.stringify(body),
    );
    const data = JSON.parse(raw);
    if (data.error) return null;
    return { id: data.id, updated: data.updated };
  } catch {
    return null;
  }
}

export async function taskUpdate(
  taskListId: string,
  taskId: string,
  updates: { title?: string; notes?: string; due?: string; completed?: boolean },
): Promise<{ ok: boolean; updated?: string }> {
  const token = await getToken();
  if (!token) return { ok: false };

  const body: Record<string, unknown> = {};
  if (updates.title !== undefined) body.title = updates.title;
  if (updates.notes !== undefined) body.notes = updates.notes;
  if (updates.due !== undefined) body.due = updates.due;
  if (updates.completed !== undefined) {
    body.status = updates.completed ? "completed" : "needsAction";
  }

  if (Object.keys(body).length === 0) return { ok: true };

  try {
    const raw = await fetchProxy(
      `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
      "PATCH",
      {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      JSON.stringify(body),
    );
    const data = JSON.parse(raw);
    if (data.error) return { ok: false };
    return { ok: true, updated: data.updated };
  } catch {
    return { ok: false };
  }
}

export async function taskDelete(taskListId: string, taskId: string): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;

  try {
    const raw = await fetchProxy(
      `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
      "DELETE",
      { Authorization: `Bearer ${token}` },
    );
    if (raw === "" || raw === "{}") return true;
    const data = JSON.parse(raw);
    return !data.error;
  } catch {
    return false;
  }
}
