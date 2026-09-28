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
import type { UserAccount } from "../types/auth.ts";

export interface CurrentUser {
  username: string;
  avatarUrl?: string;
  role?: "admin" | "user";
}

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
  currentUser?: CurrentUser;
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
function renderLayout(title: string, content: string, currentPath: string = "", currentUser?: CurrentUser): string {
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

    /* Form & Auth Styles */
    .form-group {
      margin-bottom: 16px;
      text-align: left;
    }
    .form-label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 6px;
    }
    .github-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 10px 14px;
      background: #24292f;
      color: #ffffff;
      border: 1px solid #333842;
      border-radius: var(--radius);
      font-size: 13px;
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .github-btn:hover {
      background: #2c323a;
      color: #ffffff;
    }
    .divider {
      display: flex;
      align-items: center;
      text-align: center;
      margin: 20px 0;
      color: var(--text-muted);
      font-size: 12px;
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      border-bottom: 1px solid var(--border);
    }
    .divider:not(:empty)::before {
      margin-right: .75em;
    }
    .divider:not(:empty)::after {
      margin-left: .75em;
    }
    .revoke-btn {
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.25);
      border-radius: var(--radius);
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .revoke-btn:hover {
      background: #ef4444;
      color: #ffffff;
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
          <a href="/docs/tokens" class="nav-link ${currentPath.startsWith("/docs") || currentPath === "/tokens" ? "active" : ""}">Docs</a>
        </div>
      </div>
      <div class="nav-meta" style="display: flex; align-items: center; gap: 14px;">
        ${
          currentUser
            ? `
          <div style="display: flex; align-items: center; gap: 12px;">
            <a href="/settings/tokens" class="nav-link ${currentPath.startsWith("/settings") ? "active" : ""}" style="display: flex; align-items: center; gap: 6px; font-weight: 500;">
              ${currentUser.avatarUrl ? `<img src="${escapeHtml(currentUser.avatarUrl)}" alt="${escapeHtml(currentUser.username)}" style="width: 20px; height: 20px; border-radius: 50%;" />` : ''}
              <span>${escapeHtml(currentUser.username)}</span>
            </a>
            <a href="/settings/tokens" class="nav-link ${currentPath === "/settings/tokens" ? "active" : ""}" style="font-size: 13px;">Tokens</a>
            <a href="/logout" class="nav-link" style="color: var(--text-muted); font-size: 13px;">Sign out</a>
          </div>`
            : `
          <div style="display: flex; align-items: center; gap: 10px;">
            <a href="/login" class="nav-link ${currentPath === "/login" ? "active" : ""}" style="font-size: 13px;">Sign in</a>
            <a href="/register" style="padding: 5px 12px; font-size: 12px; font-weight: 600; background: var(--accent); color: #ffffff; border-radius: var(--radius); text-decoration: none;">Sign up</a>
          </div>`
        }
      </div>
    </div>
  </nav>

  <main class="main-content">
    ${content}
  </main>

  <footer class="footer">
    <strong>Strata Git</strong> &middot; Distributed Version Control Platform
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
 * Dedicated Access Token & Authentication Documentation Page (/docs/tokens).
 */
export function renderTokensGuide(serverUrl: string, currentUser?: CurrentUser): string {
  const content = `
    <div style="max-width: 860px; margin: 0 auto;">
      <div style="margin-bottom: 28px;">
        <h1 style="font-size: 26px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 8px;">Access Tokens &amp; Authentication Guide</h1>
        <p style="color: var(--text-muted); font-size: 14px;">How to generate cryptographically secure keys and authenticate with Git CLI, CI/CD, and Strata's Web Explorer.</p>
      </div>

      <!-- Web Token Generator Banner -->
      <div class="panel" style="padding: 20px 24px; border-color: var(--border-accent); background: var(--accent-subtle); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; margin-bottom: 32px;">
        <div>
          <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 4px;">Manage Personal Access Tokens Online</h3>
          <p style="color: var(--text-muted); font-size: 13px; margin: 0;">Create, copy, and revoke Personal Access Tokens directly from your browser. No terminal commands required.</p>
        </div>
        <div>
          <a href="/settings/tokens" style="display: inline-block; padding: 8px 18px; font-size: 13px; font-weight: 600; background: var(--accent); color: #ffffff; border-radius: var(--radius); text-decoration: none;">
            Open Token Settings &rarr;
          </a>
        </div>
      </div>

      <!-- Quick Session Unlock Card -->
      <div class="panel" style="padding: 24px; border-color: var(--border); margin-bottom: 32px;">
        <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 6px;">Already have a Personal Access Token?</h3>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px;">Activate your browser session to access your private repositories in the Web Explorer without repeated prompts.</p>
        <form method="GET" action="/" style="display: flex; gap: 10px;">
          <input type="password" name="t" class="auth-input" placeholder="Paste your token (pat_...)" style="margin-bottom: 0; flex: 1; background: var(--bg);" required />
          <button type="submit" class="auth-btn" style="width: auto; padding: 0 24px;">Activate Session</button>
        </form>
      </div>

      <!-- Step 1: Generate PAT via Web UI -->
      <div style="margin-bottom: 36px;">
        <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 12px;">1. Generating a Personal Access Token (Web Portal)</h2>
        <p style="margin-bottom: 14px; color: var(--text-muted); line-height: 1.6;">
          Strata implements zero plaintext password storage. All access tokens start with <code>pat_</code> and are hashed using <strong>Argon2id</strong> before being committed to the authoritative authentication manifest.
        </p>

        <p style="margin-bottom: 8px; font-weight: 500;">Steps to generate a token:</p>
        <ol style="margin-left: 20px; margin-bottom: 16px; color: var(--text-muted); line-height: 1.8; font-size: 13px;">
          <li>Sign in to your account via <a href="/login" style="color: var(--accent); font-weight: 600;">Sign In</a> using GitHub OAuth or your email and password.</li>
          <li>Navigate to your account <a href="/settings/tokens" style="color: var(--accent); font-weight: 600;">Token Settings</a>.</li>
          <li>Enter a descriptive name (e.g. <code>Laptop Git CLI</code> or <code>CI/CD Runner</code>).</li>
          <li>Select your desired expiration (30 days, 90 days, or 1 year) and required scopes (<code>read</code>, <code>write</code>, <code>admin</code>).</li>
          <li>Click <strong>Generate Personal Access Token</strong> and immediately copy your token key.</li>
        </ol>

        <div class="callout">
          <strong>Security Note:</strong> Your raw token is displayed <strong>only once</strong> upon creation. If lost, you can revoke the token and generate a new one at any time in <a href="/settings/tokens" style="color: var(--accent); font-weight: 600;">Token Settings</a>.
        </div>
      </div>

      <!-- Step 2: Git CLI Usage -->
      <div style="margin-bottom: 36px;">
        <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 12px;">2. Authenticating Git CLI with Strata</h2>
        <p style="margin-bottom: 16px; color: var(--text-muted); line-height: 1.6;">
          You can authenticate your native Git CLI in three ways. Method A is the most direct and reliable:
        </p>

        <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 6px; color: var(--accent);">Method A: Direct Token Path (Recommended)</h3>
        <p style="margin-bottom: 8px; color: var(--text-muted); font-size: 13px;">
          Embedding the token in the URL path allows Git to authenticate immediately on the first request without interactive credential prompts:
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
        <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 12px;">4. Repository Privacy &amp; Access Control</h2>
        <p style="margin-bottom: 8px; color: var(--text-muted); font-size: 13px; line-height: 1.6;">
          When you push a repository using your personal access token, it is automatically assigned to your account:
        </p>
        <ul style="margin-left: 20px; color: var(--text-muted); font-size: 13px; line-height: 1.8;">
          <li><strong>Public Repositories:</strong> Anyone can explore files, commit history, and clone via HTTP without credentials.</li>
          <li><strong>Private Repositories:</strong> Require authentication using a Personal Access Token with <code>read</code> scope to clone or view in the browser.</li>
          <li><strong>Write Access:</strong> Pushing commits or creating new branches requires a token with <code>write</code> or <code>admin</code> permissions.</li>
        </ul>
      </div>
    </div>
  `;

  return renderLayout("Access Tokens & Authentication Guide", content, "/docs/tokens", currentUser);
}

/**
 * Platform Home & Repository Directory (Strictly Hosted Repositories, No Marketing Slop).
 */
export function renderHome(
  repos: { repoId: string; visibility: string; owner?: string }[],
  serverUrl: string = "",
  currentUser?: CurrentUser
): string {
  const repoCards = repos
    .map((r) => {
      const parts = r.repoId.split("/");
      const ownerName = r.owner || (parts.length > 1 ? parts[0] : "milan");
      const repoName = parts.length > 1 ? parts.slice(1).join("/") : r.repoId;
      return `
    <div class="panel" style="margin-bottom: 12px; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px;">
      <div>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <a href="/${escapeHtml(r.repoId)}" style="font-size: 15px; font-weight: 600; text-decoration: none;">
            <span style="color: var(--text-muted); font-weight: 500;">${escapeHtml(ownerName)} /</span> <span style="color: var(--text);">${escapeHtml(repoName)}</span>
          </a>
          <span class="badge ${r.visibility === "private" ? "badge-private" : "badge-public"}">${escapeHtml(r.visibility)}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; margin-top: 6px; font-size: 12px; color: var(--text-muted);">
          <span>Owner: <strong style="color: var(--text); font-weight: 500;">@${escapeHtml(ownerName)}</strong></span>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 16px;">
        <a href="/${escapeHtml(r.repoId)}" style="font-size: 13px; color: var(--accent); font-weight: 600; text-decoration: none;">Explore &rarr;</a>
      </div>
    </div>`;
    })
    .join("\n");

  const content = `
    <!-- Hosted Repositories List -->
    <div style="margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;">
      <div>
        <h1 style="font-size: 22px; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 4px;">Hosted Repositories</h1>
        <p style="font-size: 13px; color: var(--text-muted);">Explore and collaborate on Git repositories.</p>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <span style="font-size: 13px; color: var(--text-muted); font-family: var(--font-mono);">${repos.length} repo${repos.length === 1 ? "" : "s"}</span>
        <a href="/docs/tokens" style="font-size: 12px; font-weight: 500; color: var(--text-muted); padding: 5px 12px; border: 1px solid var(--border); border-radius: var(--radius);">CLI Docs &rarr;</a>
      </div>
    </div>

    ${repoCards || `<div class="panel" style="padding: 48px; text-align: center; color: var(--text-muted);">No repositories found. Push your first repository using Git CLI!</div>`}
  `;

  return renderLayout("Repositories", content, "/", currentUser);
}

/**
 * Sign In Page with Email/Password & GitHub OAuth.
 */
export function renderLogin(params: {
  error?: string;
  redirect?: string;
  githubEnabled?: boolean;
}): string {
  const redirectInput = params.redirect
    ? `<input type="hidden" name="redirect" value="${escapeHtml(params.redirect)}" />`
    : "";

  const githubSection = params.githubEnabled
    ? `
      <a href="/auth/github${params.redirect ? `?redirect=${encodeURIComponent(params.redirect)}` : ""}" class="github-btn">
        <svg height="18" width="18" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path>
        </svg>
        <span>Continue with GitHub</span>
      </a>
      <div class="divider">or with email / username</div>
    `
    : "";

  const content = `
    <div class="auth-gate" style="text-align: left;">
      <h2 style="font-size: 20px; font-weight: 700; margin-bottom: 6px; text-align: center;">Sign in to Strata Git</h2>
      <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px; text-align: center;">Manage repositories, generate PATs, and explore code.</p>

      ${params.error ? `<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; padding: 10px 14px; border-radius: var(--radius); font-size: 13px; margin-bottom: 16px;">${escapeHtml(params.error)}</div>` : ""}

      ${githubSection}

      <form method="POST" action="/login">
        ${redirectInput}
        <div class="form-group">
          <label class="form-label">Username or Email</label>
          <input type="text" name="identifier" class="auth-input" placeholder="milan or you@example.com" required autofocus />
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <input type="password" name="password" class="auth-input" placeholder="••••••••" required />
        </div>
        <button type="submit" class="auth-btn">Sign In</button>
      </form>

      <div style="margin-top: 24px; text-align: center; font-size: 13px; color: var(--text-muted);">
        Don't have an account? <a href="/register${params.redirect ? `?redirect=${encodeURIComponent(params.redirect)}` : ""}" style="color: var(--accent); font-weight: 500;">Create account &rarr;</a>
      </div>
    </div>
  `;

  return renderLayout("Sign In", content, "/login");
}

/**
 * Register Account Page.
 */
export function renderRegister(params: {
  error?: string;
  redirect?: string;
  githubEnabled?: boolean;
}): string {
  const redirectInput = params.redirect
    ? `<input type="hidden" name="redirect" value="${escapeHtml(params.redirect)}" />`
    : "";

  const githubSection = params.githubEnabled
    ? `
      <a href="/auth/github${params.redirect ? `?redirect=${encodeURIComponent(params.redirect)}` : ""}" class="github-btn">
        <svg height="18" width="18" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path>
        </svg>
        <span>Sign up with GitHub</span>
      </a>
      <div class="divider">or register with email</div>
    `
    : "";

  const content = `
    <div class="auth-gate" style="text-align: left;">
      <h2 style="font-size: 20px; font-weight: 700; margin-bottom: 6px; text-align: center;">Create your account</h2>
      <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px; text-align: center;">Host repositories, manage code, and generate access keys.</p>

      ${params.error ? `<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; padding: 10px 14px; border-radius: var(--radius); font-size: 13px; margin-bottom: 16px;">${escapeHtml(params.error)}</div>` : ""}

      ${githubSection}

      <form method="POST" action="/register">
        ${redirectInput}
        <div class="form-group">
          <label class="form-label">Username</label>
          <input type="text" name="username" class="auth-input" placeholder="e.g. milangohel" required pattern="[a-zA-Z0-9_.-]+" title="Alphanumeric, dots, hyphens, and underscores" autofocus />
        </div>
        <div class="form-group">
          <label class="form-label">Email (Optional)</label>
          <input type="email" name="email" class="auth-input" placeholder="you@example.com" />
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <input type="password" name="password" class="auth-input" placeholder="At least 6 characters" required minlength="6" />
        </div>
        <button type="submit" class="auth-btn">Create Account</button>
      </form>

      <div style="margin-top: 24px; text-align: center; font-size: 13px; color: var(--text-muted);">
        Already have an account? <a href="/login${params.redirect ? `?redirect=${encodeURIComponent(params.redirect)}` : ""}" style="color: var(--accent); font-weight: 500;">Sign in &rarr;</a>
      </div>
    </div>
  `;

  return renderLayout("Create Account", content, "/register");
}

/**
 * In-Browser Personal Access Token Settings Page (/settings/tokens).
 */
export function renderTokenSettings(params: {
  user: UserAccount;
  newToken?: string;
  serverUrl: string;
  error?: string;
  success?: string;
  currentUser?: CurrentUser;
}): string {
  const tokenRows = (params.user.tokens || []).map((t) => `
    <tr class="tree-row">
      <td class="tree-cell"><strong>${escapeHtml(t.name)}</strong></td>
      <td class="tree-cell"><code style="color: var(--accent); font-family: var(--font-mono);">${escapeHtml(t.tokenPrefix)}</code></td>
      <td class="tree-cell">
        ${t.scopes.map((s) => `<span class="badge ${s === 'admin' ? 'badge-private' : 'badge-public'}" style="margin-right: 4px;">${escapeHtml(s)}</span>`).join("")}
      </td>
      <td class="tree-cell" style="font-size: 12px; color: var(--text-muted);">${new Date(t.createdAt).toLocaleDateString()}</td>
      <td class="tree-cell" style="font-size: 12px; color: var(--text-muted);">${t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString() : 'Never'}</td>
      <td class="tree-cell" style="text-align: right;">
        <form method="POST" action="/settings/tokens/revoke" style="display: inline;" onsubmit="return confirm('Revoke token \\'${escapeHtml(t.name)}\\'? This action cannot be undone.');">
          <input type="hidden" name="tokenId" value="${escapeHtml(t.id)}" />
          <button type="submit" class="revoke-btn">Revoke</button>
        </form>
      </td>
    </tr>
  `).join("\n");

  const alertBanner = params.newToken ? `
    <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid var(--accent); border-radius: var(--radius); padding: 20px; margin-bottom: 28px;">
      <div style="display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--accent); margin-bottom: 6px; font-size: 15px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
        New Personal Access Token Generated!
      </div>
      <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">
        Make sure to copy your personal access token now. <strong>You will not be able to see it again!</strong>
      </p>
      <div class="code-terminal" style="margin: 0; padding: 12px 16px;">
        <span style="font-family: var(--font-mono); font-size: 13px; color: var(--accent);">${escapeHtml(params.newToken)}</span>
        <button class="copy-overlay-btn" onclick="copyText('${escapeHtml(params.newToken)}', this)">Copy</button>
      </div>
    </div>
  ` : "";

  const content = `
    <div style="max-width: 900px; margin: 0 auto;">
      <div style="margin-bottom: 28px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;">
        <div>
          <h1 style="font-size: 24px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 4px;">Personal Access Tokens</h1>
          <p style="font-size: 13px; color: var(--text-muted);">Manage authentication tokens used for Git CLI operations, CI/CD pipelines, and API access.</p>
        </div>
        <div>
          <a href="/docs/tokens" style="font-size: 12px; font-weight: 500; color: var(--text-muted); padding: 5px 12px; border: 1px solid var(--border); border-radius: var(--radius);">CLI Documentation &rarr;</a>
        </div>
      </div>

      ${alertBanner}

      ${params.error ? `<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; padding: 12px 16px; border-radius: var(--radius); font-size: 13px; margin-bottom: 20px;">${escapeHtml(params.error)}</div>` : ""}
      ${params.success ? `<div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); color: var(--accent); padding: 12px 16px; border-radius: var(--radius); font-size: 13px; margin-bottom: 20px;">${escapeHtml(params.success)}</div>` : ""}

      <!-- Generate New Token Card -->
      <div class="panel" style="padding: 24px; margin-bottom: 32px;">
        <h2 style="font-size: 16px; font-weight: 600; margin-bottom: 16px;">Generate New Personal Access Token</h2>
        <form method="POST" action="/settings/tokens/generate">
          <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 16px; margin-bottom: 16px;">
            <div>
              <label class="form-label">Token Description / Name</label>
              <input type="text" name="name" class="auth-input" placeholder="e.g. Work Laptop, CI Runner, Automation" required style="margin-bottom: 0;" />
            </div>
            <div>
              <label class="form-label">Expiration</label>
              <select name="expiresInDays" class="auth-input" style="margin-bottom: 0; background: var(--bg); cursor: pointer;">
                <option value="30">30 days</option>
                <option value="60">60 days</option>
                <option value="90" selected>90 days</option>
                <option value="365">1 year</option>
                <option value="0">No expiration</option>
              </select>
            </div>
          </div>

          <div style="margin-bottom: 20px;">
            <label class="form-label" style="margin-bottom: 8px;">Select Scopes</label>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;">
              <label style="display: flex; align-items: flex-start; gap: 10px; font-size: 13px; cursor: pointer; background: var(--surface); padding: 10px; border-radius: var(--radius); border: 1px solid var(--border);">
                <input type="checkbox" name="scopes" value="read" checked style="margin-top: 2px;" />
                <div>
                  <strong>read</strong>
                  <div style="font-size: 12px; color: var(--text-muted);">Clone and fetch repositories, browse private repos</div>
                </div>
              </label>
              <label style="display: flex; align-items: flex-start; gap: 10px; font-size: 13px; cursor: pointer; background: var(--surface); padding: 10px; border-radius: var(--radius); border: 1px solid var(--border);">
                <input type="checkbox" name="scopes" value="write" checked style="margin-top: 2px;" />
                <div>
                  <strong>write</strong>
                  <div style="font-size: 12px; color: var(--text-muted);">Push commits, create new repositories</div>
                </div>
              </label>
              <label style="display: flex; align-items: flex-start; gap: 10px; font-size: 13px; cursor: pointer; background: var(--surface); padding: 10px; border-radius: var(--radius); border: 1px solid var(--border);">
                <input type="checkbox" name="scopes" value="admin" style="margin-top: 2px;" />
                <div>
                  <strong>admin</strong>
                  <div style="font-size: 12px; color: var(--text-muted);">Full admin rights, compaction triggers, user management</div>
                </div>
              </label>
            </div>
          </div>

          <button type="submit" class="auth-btn" style="width: auto; padding: 10px 24px;">Generate Token</button>
        </form>
      </div>

      <!-- Active Tokens List -->
      <div style="margin-bottom: 16px;">
        <h2 style="font-size: 16px; font-weight: 600; margin-bottom: 12px;">Active Personal Access Tokens</h2>
      </div>

      <div class="panel" style="padding: 0; overflow-x: auto;">
        <table class="tree-table">
          <thead>
            <tr style="border-bottom: 1px solid var(--border); background: var(--surface);">
              <th class="tree-cell" style="font-weight: 600; font-size: 12px; text-transform: uppercase;">Name</th>
              <th class="tree-cell" style="font-weight: 600; font-size: 12px; text-transform: uppercase;">Token Prefix</th>
              <th class="tree-cell" style="font-weight: 600; font-size: 12px; text-transform: uppercase;">Scopes</th>
              <th class="tree-cell" style="font-weight: 600; font-size: 12px; text-transform: uppercase;">Created</th>
              <th class="tree-cell" style="font-weight: 600; font-size: 12px; text-transform: uppercase;">Last Used</th>
              <th class="tree-cell" style="font-weight: 600; font-size: 12px; text-transform: uppercase; text-align: right;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${tokenRows || `<tr><td colspan="6" style="padding: 32px; text-align: center; color: var(--text-muted); font-size: 13px;">No active tokens. Generate your first token above!</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  return renderLayout("Token Settings", content, "/settings/tokens", params.currentUser);
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
        <div class="repo-breadcrumbs" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <a href="/${ctx.repoId}" style="text-decoration: none; font-size: 18px;">
            <span style="color: var(--text-muted); font-weight: 500;">${escapeHtml(ctx.owner || (ctx.repoId.includes("/") ? ctx.repoId.split("/")[0] : "milan"))} /</span>
            <strong>${escapeHtml(ctx.name)}</strong>
          </a>
          <span class="badge ${ctx.visibility === "private" ? "badge-private" : "badge-public"}">${escapeHtml(ctx.visibility)}</span>
          <span style="font-size: 12px; color: var(--text-muted); margin-left: 4px;">Owner: <strong style="color: var(--text); font-weight: 500;">@${escapeHtml(ctx.owner || (ctx.repoId.includes("/") ? ctx.repoId.split("/")[0] : "milan"))}</strong></span>
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

  return renderLayout(ctx.repoId, content, `/${ctx.repoId}`, ctx.currentUser);
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
  const ownerPrefix = ctx.owner || (ctx.repoId.includes("/") ? ctx.repoId.split("/")[0] : "");
  let breadcrumbTrail = `<a href="/${ctx.repoId}">${ownerPrefix ? `<span style="color: var(--text-muted); font-weight: 500;">${escapeHtml(ownerPrefix)} / </span>` : ""}<strong>${escapeHtml(ctx.name)}</strong></a>`;
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

  return renderLayout(`${subpath} at ${ctx.currentBranch} · ${ctx.repoId}`, content, `/${ctx.repoId}`, ctx.currentUser);
}

/**
 * File Blob Viewer (/:repoId/blob/:branch/:path*).
 */
export function renderBlobView(
  ctx: RepoContext,
  blob: BlobInfo
): string {
  const parts = blob.path.split("/");
  const ownerPrefix = ctx.owner || (ctx.repoId.includes("/") ? ctx.repoId.split("/")[0] : "");
  let breadcrumbTrail = `<a href="/${ctx.repoId}">${ownerPrefix ? `<span style="color: var(--text-muted); font-weight: 500;">${escapeHtml(ownerPrefix)} / </span>` : ""}<strong>${escapeHtml(ctx.name)}</strong></a>`;
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

  return renderLayout(`${parts[parts.length - 1]} · ${ctx.repoId}`, content, `/${ctx.repoId}`, ctx.currentUser);
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
        <div class="repo-breadcrumbs" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <a href="/${ctx.repoId}" style="text-decoration: none; font-size: 18px;">
            <span style="color: var(--text-muted); font-weight: 500;">${escapeHtml(ctx.owner || (ctx.repoId.includes("/") ? ctx.repoId.split("/")[0] : "milan"))} /</span>
            <strong>${escapeHtml(ctx.name)}</strong>
          </a>
          <span class="badge ${ctx.visibility === "private" ? "badge-private" : "badge-public"}">${escapeHtml(ctx.visibility)}</span>
          <span style="font-size: 12px; color: var(--text-muted); margin-left: 4px;">Owner: <strong style="color: var(--text); font-weight: 500;">@${escapeHtml(ctx.owner || (ctx.repoId.includes("/") ? ctx.repoId.split("/")[0] : "milan"))}</strong></span>
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

  return renderLayout(`Commits · ${ctx.repoId}`, content, `/${ctx.repoId}`, ctx.currentUser);
}

/**
 * Private Repository Auth Gate.
 */
export function renderAuthGate(repoId: string, error?: string, currentUser?: CurrentUser): string {
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
        Don't have a token? <a href="/docs/tokens" style="color: var(--accent); font-weight: 500;">Read the PAT Guide &rarr;</a>
      </div>
    </div>
  `;

  return renderLayout(`Unlock ${repoId}`, content, `/${repoId}`, currentUser);
}
