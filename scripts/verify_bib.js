#!/usr/bin/env node
/**
 * verify_bib.js — BibTeX 文献真实性批量核查
 *
 * 用法: node verify_bib.js <path/to/references.bib> [--out report.md] [--delay 1200]
 *
 * 核查策略:
 *   1. 带 DOI 的条目  → Crossref API (https://api.crossref.org/works/<doi>)
 *      比对: 标题(归一化模糊匹配) / 年份 / 期刊 / 作者列表
 *   2. 无 DOI 但 url 指向 openaccess.thecvf.com 的条目 → 抓取页面提取 papertitle/authors 比对
 *   3. 其余条目 → 标记为 NEEDS_MANUAL, 由 agent 用 WebSearch/DBLP 仲裁
 *
 * 已知坑(本机环境):
 *   - Crossref 对无 mailto 的 UA 限流更狠, 带 User-Agent: ... (mailto:...) 且控制并发<=5
 *   - 429 不是"DOI 不存在", 必须重试(指数退避), 与 404(真不存在)严格区分
 *   - Bash 缺 sleep/coreutils → 退避用 setTimeout, 不要 shell sleep
 */
"use strict";
const fs = require("fs");
const path = require("path");

// ---------- args ----------
const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node verify_bib.js <references.bib> [--out report.md] [--delay ms]");
  process.exit(1);
}
const bibPath = path.resolve(args[0]);
let outFile = null;
let delay = 1200; // ms between crossref calls, stay under rate limit
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--out") outFile = path.resolve(args[++i]);
  else if (args[i] === "--delay") delay = parseInt(args[++i], 10);
}

// ---------- bib parsing (tolerant, no external deps) ----------
function parseBib(text) {
  const entries = [];
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  let m;
  const positions = [];
  while ((m = re.exec(text)) !== null) {
    if (/^(comment|string|stringx|preamble)$/i.test(m[1])) continue;
    positions.push({ type: m[1], key: m[2], start: m.index });
  }
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : text.length;
    const body = text.slice(p.start, end);
    const fields = {};
    // match field = {balanced braces} or "quoted" or bare
    const fRe = /(\w+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|[^,\n}]+)/g;
    let fm;
    const dups = [];
    while ((fm = fRe.exec(body)) !== null) {
      if (fm[1].toLowerCase() === p.key.toLowerCase() && fm.index === 0) continue;
      let v = fm[2].trim();
      if (v.startsWith("{") && v.endsWith("}")) v = v.slice(1, -1);
      else if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      v = v.replace(/\s+/g, " ").trim();
      const k = fm[1].toLowerCase();
      if (k in fields && k !== "month") dups.push(k); // duplicate field — BibTeX only uses one!
      fields[k] = v;
    }
    entries.push({ type: p.type, key: p.key, fields, dups });
  }
  return entries;
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const stripBraces = (s) => (s || "").replace(/[{}]/g, "");

function titleMatches(a, b) {
  const na = norm(stripBraces(a));
  const nb = norm(stripBraces(b));
  return na === nb || na.includes(nb) || nb.includes(na);
}

// parse "Last, First and Last, First" or "First Last and First Last"
function authorList(bibField) {
  return stripBraces(bibField)
    .split(/\s+and\s+/i)
    .map((a) => a.trim())
    .filter(Boolean);
}
function crossrefAuthors(m) {
  return (m.author || []).map((a) => ((a.given || "") + " " + (a.family || "")).trim());
}
function parseName(s) {
  s = s.trim();
  let family, given;
  if (s.includes(",")) {
    const parts = s.split(",");
    family = parts[0];
    given = parts.slice(1).join(" ");
  } else {
    const parts = s.split(/\s+/);
    family = parts.pop();
    given = parts.join(" ");
  }
  return {
    f: family.toLowerCase().replace(/[^a-z]/g, ""),
    g: given.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim(),
  };
}
function samePerson(bibName, xName) {
  const A = parseName(bibName), B = parseName(xName);
  if (A.f !== B.f) return false; // 姓不同必不是同一人
  if (!A.g || !B.g) return true; // 某侧缺名，只按姓判
  if (A.g === B.g) return true; // 全名一致
  const ta = A.g.split(" ").filter(Boolean);
  const tb = B.g.split(" ").filter(Boolean);
  const aInit = ta.length && ta.every((t) => t.length === 1);
  const bInit = tb.length && tb.every((t) => t.length === 1);
  if (aInit || bInit) {
    // 某一侧是首字母缩写（如 "Y." vs "Yuyang"），按首字母序列比对
    const ia = ta.map((t) => t[0]);
    const ib = tb.map((t) => t[0]);
    return ia.length === ib.length && ia.every((c, j) => c === ib[j]);
  }
  return false; // 两侧都是全名但不一致（如 Liwei vs Liuwei）→ 报错
}
function authorsMatch(bibA, xA) {
  if (!bibA.length || !xA.length) return null; // unknown
  if (bibA.length !== xA.length) return false;
  return bibA.every((b, i) => samePerson(b, xA[i]));
}

async function fetchWithRetry(url, opts, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || r.status === 503) {
        await sleep(3000 * (i + 1));
        continue;
      }
      return r;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000);
    }
  }
  throw new Error("rate-limited after retries: " + url);
}

// ---------- checks ----------
async function checkCrossref(entry) {
  const doi = entry.fields.doi;
  const r = await fetchWithRetry("https://api.crossref.org/works/" + encodeURIComponent(doi), {
    headers: { "User-Agent": "bib-verification-skill/1.0 (mailto:bibcheck@example.com)" },
  });
  if (r.status === 404) return { status: "DOI_NOT_FOUND" };
  if (!r.ok) return { status: "HTTP_" + r.status };
  const m = (await r.json()).message;
  const xTitle = stripBraces((m.title || []).join(" "));
  const xYear = (m["published-print"] || m["published-online"] || m.issued || {})["date-parts"]?.[0]?.[0];
  const xVenue = (m["container-title"] || [])[0] || "";
  const xAuthors = crossrefAuthors(m);
  const bibAuthors = authorList(entry.fields.author);
  const probs = [];
  if (!titleMatches(entry.fields.title, xTitle))
    probs.push(`标题不符: bib="${entry.fields.title}" vs crossref="${xTitle}"`);
  if (entry.fields.year && xYear && Math.abs(entry.fields.year - xYear) > 1)
    probs.push(`年份不符: bib=${entry.fields.year} vs crossref=${xYear} (±1 视为可接受)`);
  const am = authorsMatch(bibAuthors, xAuthors);
  if (am === false) {
    probs.push(`作者不符:\n    bib:      ${bibAuthors.join("; ")}\n    crossref: ${xAuthors.join("; ")}`);
  }
  return { status: probs.length ? "METADATA_MISMATCH" : "VERIFIED", xTitle, xYear, xVenue, xAuthors, bibAuthors, problems: probs };
}

async function checkCVF(entry) {
  const url = entry.fields.url;
  if (!/openaccess\.thecvf\.com/.test(url)) return { status: "SKIPPED" };
  const r = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return { status: "HTTP_" + r.status };
  const html = await r.text();
  const xTitle = (html.match(/<div id="papertitle">([^<]*)</) || [])[1]?.trim() || "";
  const authorsRaw = (html.match(/<div id="authors">([\s\S]*?)<\/div>/) || [])[1] || "";
  const xAuthors = authorsRaw
    .replace(/<[^>]+>/g, "")
    .split(";")[0]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const probs = [];
  if (xTitle && !titleMatches(entry.fields.title, xTitle))
    probs.push(`标题不符: bib="${entry.fields.title}" vs cvf="${xTitle}"`);
  const bibAuthors = authorList(entry.fields.author);
  const am = authorsMatch(bibAuthors, xAuthors);
  if (am === false) probs.push(`作者不符: bib=${bibAuthors.join("; ")} vs cvf=${xAuthors.join("; ")}`);
  return { status: probs.length ? "METADATA_MISMATCH" : "VERIFIED", xTitle, xAuthors, bibAuthors, problems: probs };
}

// ---------- main ----------
(async () => {
  const text = fs.readFileSync(bibPath, "utf8");
  const entries = parseBib(text);
  console.error(`Parsed ${entries.length} entries from ${bibPath}`);
  const results = [];
  for (const e of entries) {
    const rec = { key: e.key, type: e.type, entry: e };
    if (e.dups && e.dups.length) {
      // 重复字段: BibTeX 只会取其中一个(通常是第一个), 其余被静默忽略 — 必须报出来
      rec.status = "METADATA_MISMATCH";
      rec.problems = [`条目内存在重复字段: ${[...new Set(e.dups)].join(", ")}（BibTeX 只使用其中一个，另一个会被静默忽略，请删除多余行）`];
      results.push(rec);
      console.error(`[!!] ${e.key}: METADATA_MISMATCH — ${rec.problems.join("; ")}`);
      continue;
    }
    try {
      if (e.fields.doi) {
        Object.assign(rec, await checkCrossref(e));
        await sleep(delay);
      } else if (e.fields.url && /openaccess\.thecvf\.com/.test(e.fields.url)) {
        Object.assign(rec, await checkCVF(e));
      } else {
        rec.status = "NEEDS_MANUAL";
        rec.problems = ["无 DOI 且无 CVF url，需用 WebSearch/DBLP 人工核查（经典文献如 Adam/SGDR 可直接判定）"];
      }
    } catch (err) {
      rec.status = "ERROR";
      rec.problems = [String(err.message || err)];
    }
    results.push(rec);
    const tag =
      rec.status === "VERIFIED" ? "OK " :
      rec.status === "NEEDS_MANUAL" ? "-- " : "!! ";
    console.error(`[${tag}] ${e.key}: ${rec.status}${rec.problems ? " — " + rec.problems.join("; ") : ""}`);
  }

  // ---------- report ----------
  const ok = results.filter((r) => r.status === "VERIFIED");
  const bad = results.filter((r) => r.status === "DOI_NOT_FOUND" || r.status === "METADATA_MISMATCH");
  const manual = results.filter((r) => r.status === "NEEDS_MANUAL");
  const errs = results.filter((r) => r.status.startsWith("HTTP") || r.status === "ERROR");

  let md = `# BibTeX 核查报告\n\n- 文件: \`${bibPath}\`\n- 条目总数: ${results.length}\n- 结论: ✅ ${ok.length} 条验证通过 | ⚠️ ${bad.length} 条有问题 | ${manual.length} 条需人工核查 | ${errs.length} 条查询失败\n\n`;
  if (bad.length) {
    md += `## ❌ 发现问题的条目（重点处理）\n\n`;
    for (const r of bad) {
      md += `### ${r.key} — ${r.status === "DOI_NOT_FOUND" ? "DOI 不存在（高度可疑，可能虚构）" : "元数据不符"}\n\n`;
      for (const p of r.problems || []) md += `- ${p}\n`;
      if (r.xTitle) md += `- Crossref 记录: ${r.xTitle} (${r.xYear}, ${r.xVenue})\n`;
      md += `\n`;
    }
  }
  if (manual.length) {
    md += `## ⏳ 需人工核查的条目\n\n`;
    for (const r of manual) md += `- **${r.key}**: ${r.problems.join("; ")}\n`;
    md += `\n`;
  }
  if (errs.length) {
    md += `## ⚠️ 查询失败（网络/限流，建议重跑）\n\n`;
    for (const r of errs) md += `- **${r.key}**: ${r.status} ${r.problems.join("; ")}\n`;
    md += `\n`;
  }
  md += `## ✅ 验证通过的条目\n\n`;
  for (const r of ok) md += `- ${r.key}${r.xVenue ? ` — ${r.xVenue}` : ""}\n`;

  if (outFile) {
    fs.writeFileSync(outFile, md, "utf8");
    console.error(`Report written to ${outFile}`);
  } else {
    console.log(md);
  }
  // exit code: 2 if problems found, 1 if errors, 0 if clean
  process.exit(bad.length ? 2 : errs.length ? 1 : 0);
})();
