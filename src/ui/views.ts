/**
 * Strata Git — Minimalist Web UI & Developer Explorer
 *
 * Brand Identity: Strata (Layered S3 Write-Ahead Log Architecture)
 * Design System: Anti-Slop Frontend Taste-Skill (Linear-clean, dark-mode first, SSR)
 *
 * Features:
 * - Strata tiered geometric brand identity
 * - Interactive Personal Access Token (PAT) Documentation & Setup Guide (/tokens)
 * - Quick Start onboarding on Home page
 * - Repository browser with file tree, commits, and rendered README
 * - Subdirectory navigation and line-numbered code viewer
 * - Private repository authentication gate
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Lightweight GitHub-Flavored Markdown to HTML renderer.
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

    if (/^(\*\*\*|---|___)$/.test(line.trim())) {
      if (inList) {
        html.push(listType === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      html.push("<hr />");
      continue;
    }

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

    if (line.startsWith("> ")) {
      if (inList) {
        html.push(listType === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      const quoteText = formatInlineMarkdown(line.slice(2));
      html.push(`<blockquote><p>${quoteText}</p></blockquote>`);
      continue;
    }

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

    if (!line.trim()) {
      if (inList) {
        html.push(listType === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      continue;
    }

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
  res = res.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  res = res.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  res = res.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  res = res.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" rel="noopener noreferrer">$1</a>'
  );
  return res;
}

/**
 * Shell layout with Strata brand system and dark/light mode tokens.
 */
function renderLayout(title: string, content: string, currentPath: string = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Strata Git</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 28'><rect x='3' y='5' width='22' height='4' rx='2' fill='%2310b981'/><rect x='3' y='12' width='16' height='4' rx='2' fill='%2310b981' fill-opacity='0.7'/><rect x='3' y='19' width='20' height='4' rx='2' fill='%2310b981' fill-opacity='0.5'/><circle cx='23' cy='14' r='3' fill='%2310b981'/></svg>" />
  <style>
    :root {
      color-scheme: light dark;
      --bg: light-dark(#ffffff, #09090b);
      --surface: light-dark(#f8f9fa, #121215);
      --surface-hover: light-dark(#f1f3f5, #1c1c21);
      --border: light-dark(#e9ecef, #27272a);
      --border-accent: light-dark(rgba(16, 185, 129, 0.3), rgba(16, 185, 129, 0.4));
      --text: light-dark(#18181b, #f4f4f5);
      --text-muted: light-dark(#71717a, #a1a1aa);
      --accent: #10b981;
      --accent-subtle: light-dark(#ecfdf5, rgba(16, 185, 129, 0.1));
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

    /* Top Navigation with Strata Identity */
    .top-nav {
      height: 60px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      position: sticky;
      top: 0;
      z-index: 40;
      display: flex;
      align-items: center;
      padding: 0 24px;
      backdrop-filter: blur(8px);
    }
    .nav-container {
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .nav-left {
      display: flex;
      align-items: center;
      gap: 24px;
    }
    .nav-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 16px;
      letter-spacing: -0.02em;
    }
    .brand-mark {
      width: 24px;
      height: 24px;
    }
    .brand-tag {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--accent);
      background: var(--accent-subtle);
      border: 1px solid var(--border-accent);
      padding: 1px 6px;
      border-radius: 4px;
    }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 18px;
      font-size: 13px;
      font-weight: 500;
    }
    .nav-link {
      color: var(--text-muted);
      transition: color 0.15s ease;
    }
    .nav-link:hover, .nav-link.active {
      color: var(--text);
    }
    .nav-link.active {
      font-weight: 600;
      color: var(--accent);
    }
    .nav-meta {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .live-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--text-muted);
      background: var(--surface);
      border: 1px solid var(--border);
      padding: 4px 10px;
      border-radius: 9999px;
    }
    .pulsing-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }

    /* Main Container */
    .main-content {
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
      padding: 32px 24px 64px;
      flex: 1;
    }

    /* Card Panels & Banners */
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      margin-bottom: 24px;
    }
    .panel-header {
      padding: 12px 18px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
    }
    .panel-hero {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 28px 32px;
      margin-bottom: 32px;
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
    }
    .badge-private {
      background: rgba(239, 68, 68, 0.1);
      border-color: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }
    .badge-public {
      background: var(--accent-subtle);
      border-color: rgba(16, 185, 129, 0.25);
      color: var(--accent);
    }

    /* Clone Bar */
    .clone-box {
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 6px 12px;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .btn-copy {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      display: flex;
      align-items: center;
      transition: all 0.15s ease;
    }
    .btn-copy:hover {
      color: var(--accent);
      border-color: var(--accent);
      background: var(--surface-hover);
    }

    /* Sub Navigation Tabs */
    .repo-nav-tabs {
      display: flex;
      gap: 24px;
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

    /* Commit Bar Header */
    .commit-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 18px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 16px;
      font-size: 13px;
    }
    .commit-author {
      font-weight: 600;
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
      padding: 11px 18px;
    }
    .tree-name-cell {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .tree-icon {
      color: var(--text-muted);
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }
    .tree-size {
      color: var(--text-muted);
      text-align: right;
      font-family: var(--font-mono);
      font-size: 12px;
    }

    /* Markdown README Viewer */
    .readme-container {
      padding: 28px 36px;
    }
    .readme-container h1 { font-size: 24px; font-weight: 700; margin: 24px 0 16px; border-bottom: 1px solid var(--border); padding-bottom: 8px; letter-spacing: -0.01em; }
    .readme-container h2 { font-size: 18px; font-weight: 600; margin: 20px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    .readme-container h3 { font-size: 15px; font-weight: 600; margin: 16px 0 8px; }
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
      padding: 10px 18px;
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
      width: 52px;
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
      padding: 16px 20px;
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
      font-weight: 600;
      margin-bottom: 4px;
    }
    .commit-sub {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* Auth Gate Card */
    .auth-gate {
      max-width: 440px;
      margin: 64px auto;
      padding: 36px 32px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      text-align: center;
    }
    .auth-gate h2 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .auth-gate p {
      color: var(--text-muted);
      font-size: 13px;
      margin-bottom: 24px;
      line-height: 1.5;
    }
    .auth-input {
      width: 100%;
      padding: 11px 14px;
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
      padding: 11px;
      font-size: 13px;
      font-weight: 600;
      background: var(--accent);
      color: #ffffff;
      border: none;
      border-radius: var(--radius);
      cursor: pointer;
      transition: opacity 0.15s ease;
    }
    .auth-btn:hover {
      opacity: 0.9;
    }

    /* Documentation Callout Box */
    .callout {
      border-left: 3px solid var(--accent);
      background: var(--surface);
      padding: 16px 20px;
      border-radius: 0 var(--radius) var(--radius) 0;
      margin: 20px 0;
      font-size: 13px;
      line-height: 1.6;
    }
    .code-terminal {
      background: #09090b;
      color: #f4f4f5;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.5;
      padding: 16px 20px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      position: relative;
      margin: 16px 0;
      overflow-x: auto;
    }
    .copy-overlay-btn {
      position: absolute;
      top: 10px;
      right: 12px;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #f4f4f5;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 4px;
      cursor: pointer;
    }
    .copy-overlay-btn:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    /* Footer */
    .footer {
      border-top: 1px solid var(--border);
      padding: 28px 24px;
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <nav class="top-nav">
    <div class="nav-container">
      <div class="nav-left">
        <a href="/" class="nav-brand">
          <svg class="brand-mark" viewBox="0 0 28 28" fill="none">
            <rect x="3" y="5" width="22" height="4" rx="2" fill="currentColor" fill-opacity="0.9"/>
            <rect x="3" y="12" width="16" height="4" rx="2" fill="currentColor" fill-opacity="0.7"/>
            <rect x="3" y="19" width="20" height="4" rx="2" fill="currentColor" fill-opacity="0.5"/>
            <circle cx="23" cy="14" r="3" fill="var(--accent)"/>
          </svg>
          <span>Strata</span>
          <span class="brand-tag">Git</span>
        </a>
        <div class="nav-links">
          <a href="/" class="nav-link ${currentPath === "/" ? "active" : ""}">Repositories</a>
          <a href="/tokens" class="nav-link ${currentPath === "/tokens" ? "active" : ""}">Access Tokens &amp; PAT</a>
        </div>
      </div>
      <div class="nav-meta">
        <div class="live-pill">
          <span class="pulsing-dot"></span>
          <span>AWS Lambda Serverless</span>
        </div>
      </div>
    </div>
  </nav>

  <main class="main-content">
    ${content}
  </main>

  <footer class="footer">
    <strong>Strata Git</strong> &middot; Serverless Write-Ahead Log Architecture on AWS S3 &middot; Zero Idle Cost
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
 * Dedicated Access Token & Authentication Documentation Page (/tokens).
 */
export function renderTokensGuide(serverUrl: string): string {
  const content = `
    <div style="max-width: 860px; margin: 0 auto;">
      <div style="margin-bottom: 32px;">
        <h1 style="font-size: 28px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 8px;">Personal Access Tokens (PATs) &amp; Authentication</h1>
        <p style="color: var(--text-muted); font-size: 15px;">How to generate cryptographically secure keys and authenticate with Git CLI, CI/CD, and Strata's Web Explorer.</p>
      </div>

      <!-- Quick Session Unlock Card -->
      <div class="panel" style="padding: 24px; border-color: var(--border-accent); background: var(--accent-subtle);">
        <h3 style="font-size: 16px; font-weight: 600; margin-bottom: 6px;">Already have a Personal Access Token?</h3>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px;">Activate your browser session to access your private repositories in the Web Explorer without repeated prompts.</p>
        <form method="GET" action="/" style="display: flex; gap: 10px;">
          <input type="password" name="t" class="auth-input" placeholder="Paste your token (pat_...)" style="margin-bottom: 0; flex: 1; background: var(--bg);" required />
          <button type="submit" class="auth-btn" style="width: auto; padding: 0 24px;">Activate Session</button>
        </form>
      </div>

      <!-- Step 1: Generate PAT -->
      <div style="margin-bottom: 36px;">
        <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 12px;">1. Generating a Personal Access Token</h2>
        <p style="margin-bottom: 12px; color: var(--text-muted); line-height: 1.6;">
          Strata implements zero plaintext password storage. All access tokens start with <code>pat_</code> and are hashed using <strong>Argon2id</strong> before being committed to the authoritative S3 auth manifest (<code>_auth/auth_manifest.json</code>).
        </p>

        <p style="margin-bottom: 8px; font-weight: 500;">Run this CLI command in your terminal:</p>
        <div class="code-terminal">
          bun run src/scripts/manage-auth.ts create-token &lt;username&gt; --name "Laptop Key" --scopes read,write
          <button class="copy-overlay-btn" onclick="copyText('bun run src/scripts/manage-auth.ts create-token <username> --name \\'Laptop Key\\' --scopes read,write', this)">Copy</button>
        </div>

        <div class="callout">
          <strong>Security Note:</strong> The raw token is shown in your terminal <strong>only once</strong> when generated. Save it securely in your password manager or credential store!
        </div>
      </div>

      <!-- Step 2: Git CLI Usage -->
      <div style="margin-bottom: 36px;">
        <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 12px;">2. Authenticating Git CLI with Strata</h2>
        <p style="margin-bottom: 16px; color: var(--text-muted); line-height: 1.6;">
          You can authenticate your native Git CLI in three ways. Method A is the most reliable for serverless hosting:
        </p>

        <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 6px; color: var(--accent);">Method A: Direct Token Path (Recommended for AWS Lambda)</h3>
        <p style="margin-bottom: 8px; color: var(--text-muted); font-size: 13px;">
          AWS Lambda Function URLs rename the standard HTTP <code>WWW-Authenticate</code> header, which can prevent default Git CLI basic auth prompts. Embedding the token in the URL path allows Git to authenticate immediately on the first request:
        </p>
        <div class="code-terminal">
          git clone ${escapeHtml(serverUrl)}/t/&lt;pat_token&gt;/&lt;owner&gt;/&lt;repo&gt;.git<br/>
          git push  ${escapeHtml(serverUrl)}/t/&lt;pat_token&gt;/&lt;owner&gt;/&lt;repo&gt;.git main
          <button class="copy-overlay-btn" onclick="copyText('git clone ${escapeHtml(serverUrl)}/t/<token>/<owner>/<repo>.git', this)">Copy</button>
        </div>

        <h3 style="font-size: 15px; font-weight: 600; margin: 20px 0 6px;">Method B: Standard HTTP Basic Auth</h3>
        <p style="margin-bottom: 8px; color: var(--text-muted); font-size: 13px;">
          Pass your username and token in standard Git URL credentials:
        </p>
        <div class="code-terminal">
          git clone https://&lt;username&gt;:&lt;pat_token&gt;@${escapeHtml(new URL(serverUrl).host)}/&lt;owner&gt;/&lt;repo&gt;.git
          <button class="copy-overlay-btn" onclick="copyText('git clone https://<username>:<token>@${escapeHtml(new URL(serverUrl).host)}/<owner>/<repo>.git', this)">Copy</button>
        </div>

        <h3 style="font-size: 15px; font-weight: 600; margin: 20px 0 6px;">Method C: Authorization Bearer Header (CI/CD Pipelines)</h3>
        <p style="margin-bottom: 8px; color: var(--text-muted); font-size: 13px;">
          Pass your token via Git extra headers in GitHub Actions, GitLab CI, or scripts:
        </p>
        <div class="code-terminal">
          git -c http.extraHeader="Authorization: Bearer &lt;pat_token&gt;" clone ${escapeHtml(serverUrl)}/&lt;owner&gt;/&lt;repo&gt;.git
          <button class="copy-overlay-btn" onclick="copyText('git -c http.extraHeader=\\'Authorization: Bearer <token>\\' clone ${escapeHtml(serverUrl)}/<owner>/<repo>.git', this)">Copy</button>
        </div>
      </div>

      <!-- Step 3: Scopes & Permissions -->
      <div style="margin-bottom: 36px;">
        <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 12px;">3. Token Scopes &amp; Access Control</h2>
        <table class="tree-table" style="border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden;">
          <thead>
            <tr style="background: var(--surface); text-align: left; border-bottom: 1px solid var(--border);">
              <th style="padding: 10px 16px;">Scope</th>
              <th style="padding: 10px 16px;">Description</th>
              <th style="padding: 10px 16px;">Permitted Operations</th>
            </tr>
          </thead>
          <tbody>
            <tr class="tree-row">
              <td class="tree-cell"><code>read</code></td>
              <td class="tree-cell">Read-only repository access</td>
              <td class="tree-cell"><code>git clone</code>, <code>git pull</code>, Web UI browsing</td>
            </tr>
            <tr class="tree-row">
              <td class="tree-cell"><code>write</code></td>
              <td class="tree-cell">Read and write access</td>
              <td class="tree-cell"><code>git push</code>, creating new repos, updating branches</td>
            </tr>
            <tr class="tree-row">
              <td class="tree-cell"><code>admin</code></td>
              <td class="tree-cell">Full administrative rights</td>
              <td class="tree-cell">User management, repo policies, compaction triggers</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Step 4: Repository Privacy & Collaborators -->
      <div style="margin-bottom: 36px;">
        <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 12px;">4. Managing Repository Privacy &amp; Collaborators</h2>
        <p style="margin-bottom: 8px; color: var(--text-muted); font-size: 13px;">Make a repository private so only authorized users with a valid token can clone or view it:</p>
        <div class="code-terminal">
          bun run src/scripts/manage-auth.ts set-visibility &lt;owner&gt;/&lt;repo&gt; private
          <button class="copy-overlay-btn" onclick="copyText('bun run src/scripts/manage-auth.ts set-visibility <owner>/<repo> private', this)">Copy</button>
        </div>

        <p style="margin-top: 16px; margin-bottom: 8px; color: var(--text-muted); font-size: 13px;">Grant another user access to a private repository:</p>
        <div class="code-terminal">
          bun run src/scripts/manage-auth.ts add-collaborator &lt;owner&gt;/&lt;repo&gt; &lt;username&gt; write
          <button class="copy-overlay-btn" onclick="copyText('bun run src/scripts/manage-auth.ts add-collaborator <owner>/<repo> <username> write', this)">Copy</button>
        </div>
      </div>
    </div>
  `;

  return renderLayout("Access Tokens & Authentication Guide", content, "/tokens");
}

/**
 * Platform Home & Repository Directory.
 */
export function renderHome(
  repos: { repoId: string; visibility: string; owner?: string }[],
  serverUrl: string = ""
): string {
  const repoCards = repos
    .map(
      (r) => `
    <div class="panel" style="margin-bottom: 12px; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <a href="/${escapeHtml(r.repoId)}" style="font-size: 16px; font-weight: 600;">${escapeHtml(r.repoId)}</a>
        <span class="badge ${r.visibility === "private" ? "badge-private" : "badge-public"}" style="margin-left: 10px;">${escapeHtml(r.visibility)}</span>
      </div>
      <div style="display: flex; align-items: center; gap: 16px;">
        <a href="/${escapeHtml(r.repoId)}" style="font-size: 13px; color: var(--accent); font-weight: 600;">Explore &rarr;</a>
      </div>
    </div>`
    )
    .join("\n");

  const content = `
    <!-- Strata Hero -->
    <div class="panel-hero">
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">
        <span class="brand-tag">Serverless Git Platform</span>
        <span style="font-size: 12px; color: var(--text-muted);">&middot;</span>
        <span style="font-size: 12px; color: var(--text-muted);">S3 Write-Ahead Log Engine</span>
      </div>
      <h1 style="font-size: 28px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 10px;">
        Strata Git
      </h1>
      <p style="color: var(--text-muted); font-size: 15px; max-width: 60ch; line-height: 1.6; margin-bottom: 24px;">
        High-scale, serverless Git hosting backed by AWS S3 immutable packfiles and Atomic CAS state transitions. Zero idle cost, sub-second catchups.
      </p>

      <!-- Quick Onboarding Strip -->
      <div style="background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px;">
        <div>
          <div style="font-size: 13px; font-weight: 600;">Pushing to Strata?</div>
          <div style="font-size: 12px; color: var(--text-muted);">Generate a Personal Access Token (PAT) to authenticate Git CLI.</div>
        </div>
        <div style="display: flex; gap: 10px;">
          <a href="/tokens" style="font-size: 12px; font-weight: 600; padding: 6px 14px; background: var(--accent); color: #ffffff; border-radius: var(--radius);">
            PAT Setup Guide &rarr;
          </a>
        </div>
      </div>
    </div>

    <!-- Repository Listing -->
    <div style="margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;">
      <h2 style="font-size: 18px; font-weight: 600;">Hosted Repositories</h2>
      <span style="font-size: 13px; color: var(--text-muted);">${repos.length} repository${repos.length === 1 ? "" : "ies"}</span>
    </div>

    ${repoCards || `<div class="panel" style="padding: 40px; text-align: center; color: var(--text-muted);">No repositories found. Push your first repository using Git CLI!</div>`}
  `;

  return renderLayout("Repositories", content, "/");
}

/**
 * Repository Overview (File Tree + README).
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
 * Subdirectory Tree View (/:repoId/tree/:branch/:path*).
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
 * File Blob Viewer (/:repoId/blob/:branch/:path*).
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
 * Commit History List (/:repoId/commits/:branch*).
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
 * Private Repository Auth Gate.
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
      <div style="margin-top: 20px; font-size: 12px; color: var(--text-muted);">
        Don't have a token? <a href="/tokens" style="color: var(--accent); font-weight: 500;">Read the PAT Guide &rarr;</a>
      </div>
    </div>
  `;

  return renderLayout(`Unlock ${repoId}`, content);
}
