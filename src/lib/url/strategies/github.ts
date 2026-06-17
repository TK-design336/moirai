import { fetchProxy } from "../../http/fetchProxy";
import type { FetchedContent } from "../types";

const JINA_MAX_CHARS = 8000;

function getGithubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Personal-Concierge",
  };
  const token = localStorage.getItem("pc-api-github")?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function parseGithubRepoPath(path: string): { owner: string; repo: string } | null {
  const m = path.match(/^\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

function blobToRawUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (!m) return null;
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
  } catch {
    return null;
  }
}

export async function fetchGithubReadme(url: string): Promise<FetchedContent> {
  const u = new URL(url);
  const parts = parseGithubRepoPath(u.pathname);
  if (!parts) throw new Error("Invalid GitHub repo URL");

  const apiUrl = `https://api.github.com/repos/${parts.owner}/${parts.repo}/readme`;
  const raw = await fetchProxy(apiUrl, "GET", getGithubHeaders());
  const json = JSON.parse(raw) as { content?: string; encoding?: string };
  if (!json.content) throw new Error("README not found");

  let text = json.content.replace(/\n/g, "");
  if (json.encoding === "base64") {
    text = atob(text);
  }

  return {
    url,
    source: "GitHub API",
    body: `Title: ${parts.owner}/${parts.repo} README\n\n${text.slice(0, JINA_MAX_CHARS)}`,
  };
}

export async function fetchGithubRaw(url: string): Promise<FetchedContent> {
  const rawUrl = blobToRawUrl(url);
  if (!rawUrl) throw new Error("Invalid GitHub blob URL");

  const text = await fetchProxy(rawUrl, "GET", {
    Accept: "text/plain",
    "User-Agent": "Personal-Concierge",
  });

  return {
    url,
    source: "GitHub Raw",
    body: `File: ${rawUrl}\n\n${text.slice(0, JINA_MAX_CHARS)}`,
  };
}

export async function fetchGithubIssue(url: string): Promise<FetchedContent> {
  const u = new URL(url);
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!m) throw new Error("Invalid GitHub issue URL");

  const apiUrl = `https://api.github.com/repos/${m[1]}/${m[2]}/issues/${m[3]}`;
  const raw = await fetchProxy(apiUrl, "GET", getGithubHeaders());
  const issue = JSON.parse(raw) as {
    title?: string;
    body?: string;
    state?: string;
    user?: { login?: string };
    labels?: Array<{ name?: string }>;
    comments?: number;
  };

  const labels = issue.labels?.map((l) => l.name).filter(Boolean).join(", ") ?? "";
  const body = [
    `Title: ${issue.title ?? "(no title)"}`,
    `State: ${issue.state ?? "unknown"}`,
    `Author: ${issue.user?.login ?? "unknown"}`,
    labels ? `Labels: ${labels}` : "",
    `Comments: ${issue.comments ?? 0}`,
    "",
    issue.body ?? "",
  ]
    .filter((line, i) => i > 0 || line.length > 0)
    .join("\n");

  return {
    url,
    source: "GitHub API",
    body: body.slice(0, JINA_MAX_CHARS),
  };
}
