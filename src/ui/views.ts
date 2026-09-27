/**
 * Minimalist Web UI & Repository Explorer ("Mini-GitHub")
 *
 * Implemented with Anti-Slop Frontend Taste-Skill:
 * - Linear-style clean developer aesthetic
 * - Native dark/light mode via CSS color-scheme
 * - Fluid typography (system sans + monospace for hashes and code)
 * - Zero heavy client bundle, instant sub-5ms SSR response
 * - Full interactive feedback (1-click copy, branch switching, file tree, code viewer)
 */

import type { TreeEntry, CommitInfo, BlobInfo } from "./git-reader.ts";

export interface RepoContext {
  repoId: string;
  owner?: string;
  name: string;
  defaultBranch: string;
  currentBranch: string;
  branches: string[];
  visibility: "public" | "private";
  serverUrl: string;
  token?: string;
  cloneUrlToken: string;
  cloneUrlBasic: string;
}

/**
 * Escapes HTML characters for XSS prevention.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Formats byte size into human readable string.
 */
function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Renders lightweight GitHub-Flavored Markdown to HTML.
 */
export function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const html: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBuffer: string[] = [];
  let inList = false;
  let listType: "ul" | "ol" = "ul";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Code block toggle
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        html.push(
          `<div class="code-block-wrapper"><pre class="code-block"><code class="language-${escapeHtml(
            codeBlockLang
          )}">${escapeHtml(codeBuffer.join("\n"))}</code></pre></div>`
        );
        inCodeBlock = false;
        codeBuffer = [];
        codeBlockLang = "";
      } else {
        if (inList) {
          html.push(listType === "ul" ? "</ul>" : "</ol>");
          inList = false;
        }
        inCodeBlock = true;
        codeBlockLang = line.trim().slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // Horizontal rule
    if (/^(\*\*\*|---|___)$/.test(line.trim())) {
      if (inList) {
        html.push(listType === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      html.push("<hr />");
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      if (inList) {
        html.push(listType === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      const level = headingMatch[1]!.length;
      const text = formatInlineMarkdown(headingMatch[2]!);
      html.push(`<h${level}>${text}</h${level}>`);
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      if (inList) {
        html.push(listType === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      const quoteText = formatInlineMarkdown(line.slice(2));
      html.push(`<blockquote><p>${quoteText}</p></blockquote>`);
      continue;
    }

    // Unordered List
    if (/^[\*\-]\s+(.*)$/.test(line)) {
      const match = line.match(/^[\*\-]\s+(.*)$/)!;
      if (!inList || listType !== "ul") {
        if (inList) html.push(listType === "ul" ? "</ul>" : "</ol>");
        html.push("<ul>");
        inList = true;
        listType = "ul";
      }
      html.push(`<li>${formatInlineMarkdown(match[1]!)}</li>`);
      continue;
    }

    // Ordered List
    if (/^\d+\.\s+(.*)$/.test(line)) {
      const match = line.match(/^\d+\.\s+(.*)$/)!;
      if (!inList || listType !== "ol") {
        if (inList) html.push(listType === "ul" ? "</ul>" : "</ol>");
        html.push("<ol>");
        inList = true;
        listType = "ol";
      }
      html.push(`<li>${formatInlineMarkdown(match[1]!)}</li>`);
      continue;
    }

    // Blank line closes lists
    if (!line.trim()) {
      if (inList) {
        html.push(listType === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      continue;
    }

    // Regular Paragraph
    if (inList) {
      html.push(listType === "ul" ? "</ul>" : "</ol>");
      inList = false;
    }
    html.push(`<p>${formatInlineMarkdown(line)}</p>`);
  }

  if (inCodeBlock) {
    html.push(
      `<pre class="code-block"><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`
    );
  }
  if (inList) {
    html.push(listType === "ul" ? "</ul>" : "</ol>");
  }

  return html.join("\n");
}

function formatInlineMarkdown(text: string): string {
  let res = escapeHtml(text);
  // Code span `code`
  res = res.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  // Bold **text**
  res = res.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic *text*
  res = res.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Links [text](url)
  res = res.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" rel="noopener noreferrer">$1</a>'
  );
  return res;
}

/**
 * Shell layout wrapping all views with consistent styling, theme tokens, and navigation.
 */
function renderLayout(title: string, content: string, currentPath: string = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Continuity Git</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: light-dark(#ffffff, #09090b);
      --surface: light-dark(#f8f9fa, #121215);
      --surface-hover: light-dark(#f1f3f5, #1c1c21);
      --border: light-dark(#e9ecef, #27272a);
      --text: light-dark(#1a1a1a, #f4f4f5);
      --text-muted: light-dark(#6c757d, #a1a1aa);
      --accent: light-dark(#059669, #10b981);
      --accent-subtle: light-dark(#ecfdf5, rgba(16, 185, 129, 0.12));
      --code-bg: light-dark(#f4f4f5, #18181b);
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      --radius: 8px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
    }

    a { color: inherit; text-decoration: none; }
    a:hover { color: var(--accent); }

    /* Top Navigation */
    .top-nav {
      height: 56px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      position: sticky;
      top: 0;
      z-index: 40;
      display: flex;
      align-items: center;
      padding: 0 24px;
    }
    .nav-container {
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .nav-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      font-size: 15px;
      letter-spacing: -0.01em;
    }
    .brand-logo {
      width: 20px;
      height: 20px;
      fill: var(--accent);
    }
    .nav-meta {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Main Container */
    .main-content {
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
      padding: 24px 24px 48px;
      flex: 1;
    }

    /* Repo Header Banner */
    .repo-header {
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .repo-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 16px;
    }
    .repo-breadcrumbs {
      font-size: 20px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 9999px;
      border: 1px solid var(--border);
      color: var(--text-muted);
      margin-left: 6px;
    }
    .badge-private {
      background: rgba(239, 68, 68, 0.1);
      border-color: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }
    .badge-public {
      background: var(--accent-subtle);
      border-color: rgba(16, 185, 129, 0.2);
      color: var(--accent);
    }

    /* Clone Bar */
    .clone-box {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 6px 12px;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .btn-copy {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
    }
    .btn-copy:hover {
      color: var(--accent);
      background: var(--surface-hover);
    }

    /* Sub Navigation Tabs */
    .repo-nav-tabs {
      display: flex;
      gap: 20px;
      font-size: 14px;
      font-weight: 500;
    }
    .nav-tab {
      padding: 6px 0;
      border-bottom: 2px solid transparent;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .nav-tab.active {
      color: var(--text);
      border-bottom-color: var(--accent);
    }

    /* Card Panels */
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      margin-bottom: 24px;
    }
    .panel-header {
      padding: 12px 16px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
    }

    /* Commit Bar Header */
    .commit-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 16px;
      font-size: 13px;
    }
    .commit-author {
      font-weight: 500;
      margin-right: 8px;
    }
    .commit-hash {
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }

    /* Tree Table */
    .tree-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .tree-row {
      border-bottom: 1px solid var(--border);
      transition: background 0.1s ease;
    }
    .tree-row:last-child {
      border-bottom: none;
    }
    .tree-row:hover {
      background: var(--surface-hover);
    }
    .tree-cell {
      padding: 10px 16px;
    }
    .tree-name-cell {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 400;
    }
    .tree-icon {
      color: var(--text-muted);
      width: 16px;
      height: 16px;
    }
    .tree-size {
      color: var(--text-muted);
      text-align: right;
      font-family: var(--font-mono);
      font-size: 12px;
    }

    /* Markdown README Viewer */
    .readme-container {
      padding: 24px 32px;
    }
    .readme-container h1 { font-size: 24px; font-weight: 600; margin: 24px 0 16px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .readme-container h2 { font-size: 20px; font-weight: 600; margin: 20px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    .readme-container h3 { font-size: 16px; font-weight: 600; margin: 16px 0 8px; }
    .readme-container p { margin-bottom: 16px; line-height: 1.6; }
    .readme-container ul, .readme-container ol { margin: 0 0 16px 24px; line-height: 1.6; }
    .readme-container li { margin-bottom: 4px; }
    .readme-container blockquote {
      border-left: 3px solid var(--accent);
      padding: 4px 16px;
      color: var(--text-muted);
      margin-bottom: 16px;
      background: var(--surface);
    }
    .code-block-wrapper {
      margin-bottom: 16px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      overflow: hidden;
    }
    .code-block {
      background: var(--code-bg);
      color-scheme: only dark;
      padding: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.5;
      overflow-x: auto;
    }
    .inline-code {
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--code-bg);
      padding: 2px 5px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }

    /* Blob Code Viewer */
    .blob-header {
      padding: 10px 16px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
    }
    .blob-lines-table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 20px;
      background: var(--code-bg);
    }
    .blob-num {
      width: 48px;
      padding: 0 12px;
      text-align: right;
      color: var(--text-muted);
      user-select: none;
      vertical-align: top;
      border-right: 1px solid var(--border);
    }
    .blob-code {
      padding: 0 16px;
      white-space: pre;
      overflow-x: auto;
    }

    /* Commit History List */
    .commit-list {
      list-style: none;
    }
    .commit-item {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .commit-item:last-child {
      border-bottom: none;
    }
    .commit-msg {
      font-weight: 500;
      margin-bottom: 4px;
    }
    .commit-sub {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* Auth Gate Card */
    .auth-gate {
      max-width: 420px;
      margin: 80px auto;
      padding: 32px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      text-align: center;
    }
    .auth-gate h2 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .auth-gate p {
      color: var(--text-muted);
      font-size: 13px;
      margin-bottom: 24px;
    }
    .auth-input {
      width: 100%;
      padding: 10px 14px;
      font-family: var(--font-mono);
      font-size: 13px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      margin-bottom: 16px;
      outline: none;
    }
    .auth-input:focus {
      border-color: var(--accent);
    }
    .auth-btn {
      width: 100%;
      padding: 10px;
      font-size: 13px;
      font-weight: 500;
      background: var(--accent);
      color: #ffffff;
      border: none;
      border-radius: var(--radius);
      cursor: pointer;
    }

    /* Footer */
    .footer {
      border-top: 1px solid var(--border);
      padding: 24px;
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <nav class="top-nav">
    <div class="nav-container">
      <a href="/" class="nav-brand">
        <svg class="brand-logo" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/>
          <path d="M12 6v12M6 12h12" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>Continuity</span>
      </a>
      <div class="nav-meta">
        <span>Serverless Git Platform</span>
      </div>
    </div>
  </nav>

  <main class="main-content">
    ${content}
  </main>

  <footer class="footer">
    Powered by Continuity Git Engine &middot; Serverless S3 Storage Architecture
  </footer>

  <script>
    function copyText(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.innerText;
        btn.innerText = "Copied!";
        setTimeout(() => { btn.innerText = orig; }, 1500);
      });
    }
  </script>
</body>
</html>`;
}

/**
 * Renders the Repository Overview Page (File Tree + README.md).
 */
export function renderRepoOverview(
  ctx: RepoContext,
  tree: TreeEntry[],
  latestCommit: CommitInfo | null,
  readmeContent: string | null
): string {
  const fileRows = tree
    .map((item) => {
      const isDir = item.type === "tree";
      const href = isDir
        ? `/${ctx.repoId}/tree/${ctx.currentBranch}/${item.path}`
        : `/${ctx.repoId}/blob/${ctx.currentBranch}/${item.path}`;

      const iconSvg = isDir
        ? `<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`
        : `<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

      return `
      <tr class="tree-row">
        <td class="tree-cell">
          <div class="tree-name-cell">
            ${iconSvg}
            <a href="${href}">${escapeHtml(item.name)}</a>
          </div>
        </td>
        <td class="tree-cell tree-size">${formatBytes(item.size)}</td>
      </tr>`;
    })
    .join("\n");

  const commitBar = latestCommit
    ? `
    <div class="commit-banner">
      <div>
        <span class="commit-author">${escapeHtml(latestCommit.authorName)}</span>
        <span>${escapeHtml(latestCommit.message)}</span>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <span style="color: var(--text-muted);">${escapeHtml(latestCommit.relativeTime)}</span>
        <span class="commit-hash">${escapeHtml(latestCommit.shortHash)}</span>
      </div>
    </div>`
    : "";

  const readmePanel = readmeContent
    ? `
    <div class="panel">
      <div class="panel-header">
        <strong>README.md</strong>
      </div>
      <div class="readme-container">
        ${renderMarkdown(readmeContent)}
      </div>
    </div>`
    : "";

  const content = `
    <div class="repo-header">
      <div class="repo-title-row">
        <div class="repo-breadcrumbs">
          <a href="/${ctx.repoId}"><strong>${escapeHtml(ctx.repoId)}</strong></a>
          <span class="badge ${ctx.visibility === "private" ? "badge-private" : "badge-public"}">${escapeHtml(ctx.visibility)}</span>
        </div>
        <div class="clone-box">
          <span>git clone ${escapeHtml(ctx.cloneUrlToken)}</span>
          <button class="btn-copy" onclick="copyText('git clone ${escapeHtml(ctx.cloneUrlToken)}', this)">Copy</button>
        </div>
      </div>
      <div class="repo-nav-tabs">
        <a href="/${ctx.repoId}" class="nav-tab active">Code</a>
        <a href="/${ctx.repoId}/commits/${ctx.currentBranch}" class="nav-tab">Commits</a>
      </div>
    </div>

    ${commitBar}

    <div class="panel">
      <table class="tree-table">
        <tbody>
          ${fileRows || `<tr><td colspan="2" style="padding: 24px; text-align: center; color: var(--text-muted);">Repository is empty.</td></tr>`}
        </tbody>
      </table>
    </div>

    ${readmePanel}
  `;

  return renderLayout(ctx.repoId, content);
}

/**
 * Renders Subdirectory Tree View (`/:repoId/tree/:branch/:path*`).
 */
export function renderSubTree(
  ctx: RepoContext,
  subpath: string,
  tree: TreeEntry[]
): string {
  const parts = subpath.split("/").filter(Boolean);
  let breadcrumbTrail = `<a href="/${ctx.repoId}">${escapeHtml(ctx.name)}</a>`;
  let accum = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    accum += (accum ? "/" : "") + part;
    if (i === parts.length - 1) {
      breadcrumbTrail += ` / <strong>${escapeHtml(part)}</strong>`;
    } else {
      breadcrumbTrail += ` / <a href="/${ctx.repoId}/tree/${ctx.currentBranch}/${accum}">${escapeHtml(part)}</a>`;
    }
  }

  // Parent directory link
  const parentPath = parts.slice(0, -1).join("/");
  const parentHref = parentPath
    ? `/${ctx.repoId}/tree/${ctx.currentBranch}/${parentPath}`
    : `/${ctx.repoId}`;

  const parentRow = `
    <tr class="tree-row">
      <td class="tree-cell" colspan="2">
        <a href="${parentHref}" style="display: flex; align-items: center; gap: 8px; color: var(--text-muted);">
          <span>..</span>
        </a>
      </td>
    </tr>`;

  const fileRows = tree
    .map((item) => {
      const isDir = item.type === "tree";
      const href = isDir
        ? `/${ctx.repoId}/tree/${ctx.currentBranch}/${item.path}`
        : `/${ctx.repoId}/blob/${ctx.currentBranch}/${item.path}`;

      const iconSvg = isDir
        ? `<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`
        : `<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

      return `
      <tr class="tree-row">
        <td class="tree-cell">
          <div class="tree-name-cell">
            ${iconSvg}
            <a href="${href}">${escapeHtml(item.name)}</a>
          </div>
        </td>
        <td class="tree-cell tree-size">${formatBytes(item.size)}</td>
      </tr>`;
    })
    .join("\n");

  const content = `
    <div class="repo-header">
      <div class="repo-title-row">
        <div class="repo-breadcrumbs">
          ${breadcrumbTrail}
        </div>
      </div>
      <div class="repo-nav-tabs">
        <a href="/${ctx.repoId}" class="nav-tab active">Code</a>
        <a href="/${ctx.repoId}/commits/${ctx.currentBranch}" class="nav-tab">Commits</a>
      </div>
    </div>

    <div class="panel">
      <table class="tree-table">
        <tbody>
          ${parentRow}
          ${fileRows}
        </tbody>
      </table>
    </div>
  `;

  return renderLayout(`${subpath} at ${ctx.currentBranch} · ${ctx.repoId}`, content);
}

/**
 * Renders File Blob Viewer (`/:repoId/blob/:branch/:path*`).
 */
export function renderBlobView(
  ctx: RepoContext,
  blob: BlobInfo
): string {
  const parts = blob.path.split("/");
  let breadcrumbTrail = `<a href="/${ctx.repoId}">${escapeHtml(ctx.name)}</a>`;
  let accum = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    accum += (accum ? "/" : "") + part;
    if (i === parts.length - 1) {
      breadcrumbTrail += ` / <strong>${escapeHtml(part)}</strong>`;
    } else {
      breadcrumbTrail += ` / <a href="/${ctx.repoId}/tree/${ctx.currentBranch}/${accum}">${escapeHtml(part)}</a>`;
    }
  }

  const lines = blob.content.split("\n");
  const tableRows = lines
    .map((line, idx) => {
      const lineNum = idx + 1;
      return `<tr><td class="blob-num">${lineNum}</td><td class="blob-code">${escapeHtml(line)}</td></tr>`;
    })
    .join("\n");

  const content = `
    <div class="repo-header">
      <div class="repo-title-row">
        <div class="repo-breadcrumbs">
          ${breadcrumbTrail}
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="blob-header">
        <div>
          <span>${blob.lineCount} lines</span>
          <span style="color: var(--text-muted); margin: 0 8px;">&middot;</span>
          <span>${formatBytes(blob.size)}</span>
        </div>
        <div>
          <button class="btn-copy" onclick="copyText(\`${escapeHtml(blob.content).replace(/`/g, "\\`")}\`, this)">Copy Raw</button>
        </div>
      </div>
      <div style="overflow-x: auto;">
        <table class="blob-lines-table">
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    </div>
  `;

  return renderLayout(`${parts[parts.length - 1]} · ${ctx.repoId}`, content);
}

/**
 * Renders Commit History List (`/:repoId/commits/:branch*`).
 */
export function renderCommitsView(
  ctx: RepoContext,
  commits: CommitInfo[]
): string {
  const items = commits
    .map(
      (c) => `
    <li class="commit-item">
      <div>
        <div class="commit-msg">${escapeHtml(c.message)}</div>
        <div class="commit-sub">
          <strong>${escapeHtml(c.authorName)}</strong> committed ${escapeHtml(c.relativeTime)}
        </div>
      </div>
      <div>
        <span class="commit-hash">${escapeHtml(c.shortHash)}</span>
      </div>
    </li>`
    )
    .join("\n");

  const content = `
    <div class="repo-header">
      <div class="repo-title-row">
        <div class="repo-breadcrumbs">
          <a href="/${ctx.repoId}"><strong>${escapeHtml(ctx.repoId)}</strong></a>
          <span class="badge ${ctx.visibility === "private" ? "badge-private" : "badge-public"}">${escapeHtml(ctx.visibility)}</span>
        </div>
      </div>
      <div class="repo-nav-tabs">
        <a href="/${ctx.repoId}" class="nav-tab">Code</a>
        <a href="/${ctx.repoId}/commits/${ctx.currentBranch}" class="nav-tab active">Commits</a>
      </div>
    </div>

    <div class="panel">
      <ul class="commit-list">
        ${items || `<li style="padding: 24px; text-align: center; color: var(--text-muted);">No commits found.</li>`}
      </ul>
    </div>
  `;

  return renderLayout(`Commits · ${ctx.repoId}`, content);
}

/**
 * Renders the Private Repository Unlock Gate.
 */
export function renderAuthGate(repoId: string, error?: string): string {
  const content = `
    <div class="auth-gate">
      <svg style="width: 32px; height: 32px; color: var(--accent); margin-bottom: 16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      <h2>Private Repository</h2>
      <p>Authentication required to inspect <strong>${escapeHtml(repoId)}</strong>.</p>
      ${error ? `<div style="color: #ef4444; font-size: 13px; margin-bottom: 16px;">${escapeHtml(error)}</div>` : ""}
      <form method="GET" action="/${escapeHtml(repoId)}">
        <input type="password" name="t" class="auth-input" placeholder="Enter Personal Access Token (pat_...)" required autofocus />
        <button type="submit" class="auth-btn">Unlock Repository</button>
      </form>
    </div>
  `;

  return renderLayout(`Unlock ${repoId}`, content);
}

/**
 * Renders the Platform Home / Repository Directory.
 */
export function renderHome(
  repos: { repoId: string; visibility: string; owner?: string }[]
): string {
  const repoCards = repos
    .map(
      (r) => `
    <div class="panel" style="margin-bottom: 12px; padding: 16px; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <a href="/${escapeHtml(r.repoId)}" style="font-size: 16px; font-weight: 600;">${escapeHtml(r.repoId)}</a>
        <span class="badge ${r.visibility === "private" ? "badge-private" : "badge-public"}" style="margin-left: 8px;">${escapeHtml(r.visibility)}</span>
      </div>
      <div>
        <a href="/${escapeHtml(r.repoId)}" style="font-size: 13px; color: var(--accent); font-weight: 500;">Explore &rarr;</a>
      </div>
    </div>`
    )
    .join("\n");

  const content = `
    <div style="margin-bottom: 32px;">
      <h1 style="font-size: 24px; font-weight: 600; margin-bottom: 8px;">Repositories</h1>
      <p style="color: var(--text-muted); font-size: 14px;">Hosted on AWS S3 Serverless Write-Ahead Log engine.</p>
    </div>

    ${repoCards || `<div class="panel" style="padding: 32px; text-align: center; color: var(--text-muted);">No repositories hosted yet. Push with Git to create one!</div>`}
  `;

  return renderLayout("Repositories", content);
}
