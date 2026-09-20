#!/usr/bin/env node
/**
 * strict_audit.js — BibTeX 严格复核（verify_bib.js 的第二轮）
 *
 * verify_bib.js 的 titleMatches() 用的是「归一化后子串包含」，偏松；且完全不校验
 * volume / number / pages / year。本脚本做逐字严格比对，只打印异常项。
 *
 * 用法: node strict_audit.js <references.bib> [--delay 1300]
 *
 * 输出: 每条一行 JSON-ish，字段
 *   exactTitle  bib 标题与 Crossref 标题归一化后是否完全相等
 *   bibVol/xVol, bibNum/xNum, bibPages/xPages, bibYear/xYear
 *
 * 重要口径（见 SKILL.md 已知坑）：
 *   CVPR/ICCV/WACV 论文的 CVF 网页页码 与 IEEE Xplore(Crossref) 页码 经常不同，
 *   若条目同时带 openaccess.thecvf.com 的 url，页码差异只标记为 INFO，不算错误。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node strict_audit.js <references.bib> [--delay ms]");
  process.exit(1);
}
const bibPath = path.resolve(args[0]);
let delay = 1300;
for (let i = 1; i < args.length; i++) if (args[i] === "--delay") delay = parseInt(args[++i], 10);

// ---------- 复用 verify_bib.js 的解析逻辑（保持判据一致） ----------
function parseBib(text) {
  const entries = [];
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  let m;
  const positions = [];
  while ((m = re.exec(text)) !== null) {
    if (/^(comment|string|preamble)$/i.test(m[1])) continue;
    positions.push({ type: m[1], key: m[2], start: m.index });
  }
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : text.length;
    const body = text.slice(p.start, end);
    const fields = {};
    const fRe = /(\w+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|[^,\n}]+)/g;
    let fm;
    while ((fm = fRe.exec(body)) !== null) {
      let v = fm[2].trim();
      if (v.startsWith("{") && v.endsWith("}")) v = v.slice(1, -1);
      else if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      fields[fm[1].toLowerCase()] = v.replace(/\s+/g, " ").trim();
    }
    entries.push({ type: p.type, key: p.key, fields });
  }
  return entries;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 严格归一化：去括号、统一各类破折号/连字符、去标点空白、转小写
const strict = (s) =>
  (s || "")
    .replace(/[{}]/g, "")
    .replace(/[‐-―−]/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
// BibTeX 惯例写 "4996--5009"（双连字符），Crossref/IEEE 写 "4996-5009"（单连字符），
// 二者等价。必须把 ASCII 连字符和各类 Unicode 破折号一并归一，再折叠重复，否则会满屏误报。
const normPages = (s) =>
  (s || "")
    .replace(/[\u002D\u2010-\u2015\u2212\uFF0D]/g, "-")
    .replace(/-+/g, "-")
    .replace(/\s+/g, "")
    .toLowerCase();

async function fetchWithRetry(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "bib-verification-skill/1.0 (mailto:bibcheck@example.com)" },
      });
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

(async () => {
  const entries = parseBib(fs.readFileSync(bibPath, "utf8"));
  const withDoi = entries.filter((e) => e.fields.doi);
  console.log(`条目 ${entries.length} 条，其中带 DOI ${withDoi.length} 条，开始严格复核...\n`);

  let nTitle = 0,
    nVol = 0,
    nNum = 0,
    nPage = 0,
    nYear = 0,
    nInfo = 0,
    nErr = 0,
    nOk = 0;

  for (const e of withDoi) {
    let m;
    try {
      const r = await fetchWithRetry("https://api.crossref.org/works/" + encodeURIComponent(e.fields.doi));
      if (r.status === 404) {
        console.log(`[404] ${e.key}: DOI 不存在`);
        nErr++;
        await sleep(delay);
        continue;
      }
      if (!r.ok) {
        console.log(`[HTTP ${r.status}] ${e.key}: 查询失败`);
        nErr++;
        await sleep(delay);
        continue;
      }
      m = (await r.json()).message;
    } catch (err) {
      console.log(`[ERR] ${e.key}: ${err.message}`);
      nErr++;
      await sleep(delay);
      continue;
    }

    const xTitle = (m.title || []).join(" ");
    const xYear = (m["published-print"] || m["published-online"] || m.issued || {})["date-parts"]?.[0]?.[0];
    const problems = [];
    const infos = [];

    if (strict(e.fields.title) !== strict(xTitle)) {
      problems.push(`标题非逐字一致:\n      bib="${e.fields.title}"\n      xref="${xTitle}"`);
      nTitle++;
    }
    const bibVol = e.fields.volume,
      xVol = m.volume;
    if (bibVol && xVol && String(bibVol) !== String(xVol)) {
      problems.push(`卷号不符: bib=${bibVol} vs xref=${xVol}`);
      nVol++;
    }
    const bibNum = e.fields.number,
      xNum = m.issue;
    if (bibNum && xNum && String(bibNum) !== String(xNum)) {
      problems.push(`期号不符: bib=${bibNum} vs xref=${xNum}`);
      nNum++;
    }
    const bibPg = e.fields.pages,
      xPg = m.page;
    if (bibPg && xPg && normPages(bibPg) !== normPages(xPg)) {
      const hasCVF = /openaccess\.thecvf\.com/.test(e.fields.url || "");
      const line = `页码不符: bib=${bibPg} vs xref(IEEE)=${xPg}`;
      if (hasCVF) {
        infos.push(line + "  ← 条目带 CVF url，两套页码口径不同属正常，请用 CVF bibref 复核");
        nInfo++;
      } else {
        problems.push(line);
        nPage++;
      }
    }
    if (e.fields.year && xYear && Math.abs(Number(e.fields.year) - Number(xYear)) > 1) {
      problems.push(`年份不符: bib=${e.fields.year} vs xref=${xYear}`);
      nYear++;
    }

    if (problems.length) {
      console.log(`[!!] ${e.key}`);
      for (const p of problems) console.log("    - " + p);
    } else if (infos.length) {
      console.log(`[i ] ${e.key}`);
      for (const p of infos) console.log("    - " + p);
    } else {
      nOk++;
    }
    await sleep(delay);
  }

  console.log(
    `\n严格复核汇总: 完全一致 ${nOk} | 标题问题 ${nTitle} | 卷 ${nVol} | 期 ${nNum} | 页 ${nPage} | 年 ${nYear} | 页码口径提示 ${nInfo} | 查询失败 ${nErr}`
  );
  const skipped = entries.length - withDoi.length;
  if (skipped) console.log(`（另有 ${skipped} 条无 DOI，本脚本不覆盖，请用 CVF 抓取或人工核查）`);
})();
