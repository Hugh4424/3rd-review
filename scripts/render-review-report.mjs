#!/usr/bin/env node
// render-review-report.mjs — 渲染审查报告 Markdown
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Single source for the report.slimReadSet.enabled switch (FR-CFG-001). Reads the
// route-rules.json config relative to this module. Explicit null-check default: enabled
// unless explicitly false (NOT a falsy-coalescing default).
function readSlimReadSetEnabled() {
  try {
    const cfgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'route-rules.json');
    const rules = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    return rules?.report?.slimReadSet?.enabled !== false;
  } catch { return true; }
}

/** @typedef {{ severity:string; file?:string; line?:number; axis?:string; code?:string; issue:string; impact?:string; recommendation?:string; evidence?:unknown; requiredFix?:string; repeat?:boolean; cross_phase_recurrence?:boolean; [key:string]:unknown }} RawFinding */
/** @typedef {{ name:string; status:string; mode?:string; evidence?:unknown }} SkillResult */
/** @typedef {{ command?:string; exitCode?:number; evidence?:string; stdout?:string; stderr?:string; note?:string }} VerificationResult */
/** @typedef {{ id:string; displayName?:string; checkpoint?:{id:string} }} Stage */

function oneLine(value, max=120) {
  if (value===undefined||value===null||value===false) return '';
  const text = (typeof value==='string'?value:JSON.stringify(value)).replace(/\s+/g,' ').replace(/\|/g,'\\|').trim();
  return text.length>max ? text.slice(0,max-1)+'...' : text;
}

function tableCell(value) {
  if (value===undefined||value===null||value===false) return '';
  return (typeof value==='string'?value:JSON.stringify(value)).replace(/\s+/g,' ').replace(/\|/g,'\\|').trim();
}

function fenced(value) {
  const raw = typeof value==='string'?value:JSON.stringify(value,null,2);
  return ['```text',raw.replace(/```/g,'` ` `'),'```'];
}

function tokenValue(tokens, key) {
  if (!tokens||typeof tokens!=='object') return '?';
  const v = /** @type {Record<string,unknown>} */(tokens)[key];
  return typeof v==='number'||typeof v==='string'?String(v):'?';
}

function verdictLabel(v) {
  if (v==='pass') return '可以放行';
  if (v==='revise_required') return '需要返修';
  if (v==='escalate_to_human') return '需要人工介入';
  return v;
}

function severityLabel(s) {
  if (s==='blocking') return '要改的';
  if (s==='important') return '建议';
  if (s==='minor') return '其他';
  return s;
}

function titleForCheckpoint(checkpoint, stages) {
  if (!checkpoint) return '审查报告';
  if (stages?.length) {
    const m = stages.find(s=>s.checkpoint?.id===checkpoint);
    if (m) return (m.displayName||m.id).replace(/ Review$/i,'');
  }
  if (checkpoint.startsWith('code-review')) {
    const s = checkpoint.replace('code-review-phase-','').replace('code-review-','');
    return `代码审查 Phase ${s}`;
  }
  if (checkpoint.startsWith('build-spec') || checkpoint.startsWith('design')) return '设计审查';
  if (checkpoint.startsWith('build-plan') || checkpoint.startsWith('plan')) return '方案审查';
  if (checkpoint.startsWith('build-code')) return '实现审查';
  if (checkpoint.startsWith('verify-code') || checkpoint.startsWith('test-acceptance')) return '验收审查';
  if (checkpoint.startsWith('make-decision') || checkpoint.startsWith('intake')) return '需求决策审查';
  return checkpoint;
}

function shortCheckpointName(checkpoint) {
  if (!checkpoint || checkpoint === 'review') return 'review';
  let n = checkpoint.replace('code-review-phase-','code-phase');
  n = n.replace('review-','').replace('phase-','phase');
  return n.replace(/--+/g,'-').replace(/-+$/,'');
}

function renderReviewerRuntimeMeta(lines, codexMeta) {
  if (!codexMeta||codexMeta.available===false) return;
  const cm = codexMeta;
  const r = cm.reviewer&&typeof cm.reviewer==='object'?/** @type {Record<string,unknown>}*/(cm.reviewer):cm;
  const tokens = r.tokens||cm.tokens;
  const subs = Array.isArray(cm.subreviewers)?cm.subreviewers:(Array.isArray(cm.subagents)?cm.subagents:[]);
  lines.push('## 怎么审的','');
  lines.push(`- **模型**：${r.model||cm.model||'unknown'}`);
  lines.push(`- **思考强度**：${r.effort||cm.effort||'unknown'}`);
  lines.push(`- **耗时**：${r.elapsedSec??cm.elapsedSec??'?'} 秒`);
  if (tokens) lines.push(`- **token**：输入 ${tokenValue(tokens,'input_tokens')} / 缓存 ${tokenValue(tokens,'cached_input_tokens')} / 输出 ${tokenValue(tokens,'output_tokens')} / 总计 ${tokenValue(tokens,'total_tokens')}`);
  if (cm.sessionFile) lines.push(`- **会话**：${cm.sessionFile}`);
  lines.push('');
  if (subs.length>0) {
    lines.push('### 帮手审查员','','| 名称 | token | 耗时 |','|---|---:|---:|');
    for (const item of subs) {
      const sub = item&&typeof item==='object'?/** @type {Record<string,unknown>}*/(item):{};
      const st = sub.tokens;
      const n = sub.name||sub.role||sub.id||'帮手';
      const el = sub.elapsedSec!=null?`${sub.elapsedSec} 秒`:'?';
      const ts = `入 ${tokenValue(st,'input_tokens')} / 出 ${tokenValue(st,'output_tokens')} / 总 ${tokenValue(st,'total_tokens')}`;
      lines.push(`| ${oneLine(n,30)} | ${ts} | ${el} |`);
    }
  } else lines.push(`- **帮手审查员**：${cm.subagentTokenNote||'未记录'}`);
  lines.push('');
}

// Build one lens-dimension row {lens, status, findingsCount, riskCount}.
function lensDimRow(lens, reports, topRisks) {
  const ls = String(lens);
  const report = reports.find(r=>String(r?.lens)===ls);
  const sr = report&&typeof report==='object'?report.report&&typeof report.report==='object'?/** @type {Record<string,unknown>}*/(report.report):{}:{};
  const status = sr.status||report?.status||'?';
  const fc = Array.isArray(sr.candidateFindings)?sr.candidateFindings.length:0;
  const rc = Array.isArray(sr.riskFlags)?sr.riskFlags.length:topRisks.length;
  return { lens: ls, status, fc, rc };
}

// Read-list reason rendering. When slimming, ordinary entries (sourceType !== 'high_risk')
// emit a short code so the substantive reason text is suppressed; high_risk entries always
// keep the full reason. When NOT slimming, all entries keep the full reason (old behavior).
// Display-only: the underlying reason key in the data is never deleted (schema-safe).
function readSetReason(e, slim) {
  if (!slim) return tableCell(e.reason||e.sourceType||'');
  if (e.sourceType==='high_risk') return tableCell(e.reason||e.sourceType||'');
  return e.sourceType==='candidate'?'·':tableCell(e.sourceType||'');
}

function renderDelegatedReviewSummary(lines, bundle, readSet, _precheck, rawJsonPath, slim) {
  if (!bundle&&!Array.isArray(readSet)) return;
  const topRisks = Array.isArray(bundle?.topRisks)?bundle.topRisks:[];
  const recommended = Array.isArray(bundle?.recommendedFinalReadSet)?bundle.recommendedFinalReadSet:[];
  const finalReadSet = Array.isArray(readSet)?readSet:recommended;
  lines.push('## 审查包','');
  lines.push(`- **bundle 模式**：${bundle?.mode||'unknown'}`);
  lines.push(`- **topRisks**：${topRisks.length} 个`);
  if (rawJsonPath) lines.push(`- **原始 JSON**：${rawJsonPath}`);
  lines.push('');
  const precheck = _precheck;
  const reports = Array.isArray(precheck?.reports)?precheck.reports:[];
  const lensesData = Array.isArray(precheck?.lenses)?precheck.lenses:[];

  if (slim) {
    // Merged single table: lens-dimension rows and read-list rows live side by side,
    // distinguished by the 区块 column. Preserves all info from both old tables.
    if (lensesData.length>0||finalReadSet.length>0) {
      lines.push('### 维度与读取清单','','| 区块 | 项 | 状态/来源 | findings/原因 | 风险 |','|---|---|---|---|---:|');
      for (const lens of lensesData) {
        const r = lensDimRow(lens, reports, topRisks);
        lines.push(`| 维度 | ${r.lens} | ${r.status} | ${r.fc} | ${r.rc} |`);
      }
      for (const item of finalReadSet) {
        const e = item&&typeof item==='object'?/** @type {Record<string,unknown>}*/(item):{};
        lines.push(`| 读取 | ${tableCell(e.target||e.path||e.file||'?')} | ${tableCell(e.sourceType||'')} | ${readSetReason(e, true)} | |`);
      }
      lines.push('');
    }
    return;
  }

  // slimReadSet OFF: old behavior — two separate tables + full reason for all entries.
  if (lensesData.length>0) {
    lines.push('### 审查维度','','| lens | 状态 | findings | 风险 |','|---|---:|---:|---:|');
    for (const lens of lensesData) {
      const r = lensDimRow(lens, reports, topRisks);
      lines.push(`| ${r.lens} | ${r.status} | ${r.fc} | ${r.rc} |`);
    }
    lines.push('');
  }
  if (finalReadSet.length>0) {
    lines.push('### 读取清单','','| 文件 | 原因 |','|---|---|');
    for (const item of finalReadSet) {
      const e = item&&typeof item==='object'?/** @type {Record<string,unknown>}*/(item):{};
      lines.push(`| ${tableCell(e.target||e.path||e.file||'?')} | ${readSetReason(e, false)} |`);
    }
    lines.push('');
  }
}

function renderFindingReadable(lines, f, index) {
  const issue = oneLine(f.issue,90)||`问题 ${index+1}`;
  lines.push(`### ${index+1}. ${issue}`,'');
  const loc = f.file?`${f.file}${f.line?`:${f.line}`:''}`:'未提供';
  lines.push(`- 级别：${severityLabel(f.severity)}`,`- 在哪：${loc}`);
  if (f.axis) lines.push(`- 维度：${f.axis}`);
  if (f.issue) lines.push(`- 问题：${f.issue}`);
  if (f.impact) lines.push(`- 为什么重要：${f.impact}`);
  if (f.recommendation) lines.push(`- 怎么修：${f.recommendation}`);
  if (f.requiredFix) lines.push(`- 必须做到：${f.requiredFix}`);
  if (f.repeat) lines.push('- 重复出现：是');
  if (f.cross_phase_recurrence) lines.push('- 跨阶段重现：是');
  if (f.code) lines.push('','相关代码：',...fenced(f.code));
  if (f.evidence) lines.push('','证据：',...fenced(f.evidence));
  lines.push('');
}

function renderVerificationResults(lines, results) {
  if (!Array.isArray(results)||results.length===0) return;
  lines.push('## 验证','','| 命令 | exit | 结果 |','|---|---:|---|');
  for (const r of results) {
    const ev = [r.evidence,r.stdout,r.stderr,r.note].filter(Boolean).map(String).join('; ');
    const ec = r.exitCode===undefined||r.exitCode===null?'':String(r.exitCode);
    lines.push(`| ${oneLine(r.command||'',220)} | ${ec} | ${oneLine(ev,160)} |`);
  }
  lines.push('');
}

function renderReviewSnapshot(lines, snapshot) {
  if (!Array.isArray(snapshot)||snapshot.length===0) return;
  lines.push('## 被审快照','');
  for (const item of snapshot) {
    const e = item&&typeof item==='object'?/** @type {Record<string,unknown>}*/(item):{};
    lines.push(`- ${tableCell(e.path||e.file||'unknown')}`);
  }
  lines.push('');
}

function renderRiskDisposition(lines, dispositions) {
  if (!Array.isArray(dispositions)||dispositions.length===0) return;
  lines.push('## 高风险复核','','| 风险 | 检查来源 | 决策 | 为什么不是 blocking |','|---|---|---|---|');
  for (const item of dispositions) {
    const e = item&&typeof item==='object'?/** @type {Record<string,unknown>}*/(item):{};
    lines.push(`| ${tableCell(e.risk||e.target||'unknown')} | ${tableCell(e.checkedSource||e.checked_source||'')} | ${tableCell(e.decision||'')} | ${tableCell(e.whyNotBlocking||e.why_not_blocking||'')} |`);
  }
  lines.push('');
}

function renderInventoryGroup(lines, title, items) {
  lines.push(`### ${title}`,'');
  if (items.length===0) { lines.push('- 无',''); return; }
  for (const item of items) {
    const e = item&&typeof item==='object'?/** @type {Record<string,unknown>}*/(item):{};
    lines.push(`- ${tableCell(e.path||e.file||'unknown')}：${tableCell(e.reason||'')}`);
  }
  lines.push('');
}

function renderWorktreeInventory(lines, inventory) {
  if (!inventory||typeof inventory!=='object') return;
  lines.push('## Worktree 清单','');
  renderInventoryGroup(lines,'包含',Array.isArray(inventory.included)?inventory.included:[]);
  renderInventoryGroup(lines,'无关',Array.isArray(inventory.unrelated)?inventory.unrelated:[]);
  renderInventoryGroup(lines,'排除',Array.isArray(inventory.excluded)?inventory.excluded:[]);
}

export function renderReviewMarkdown(review) {
  const lines = [];
  const seq = String(review.round||1);
  const cp = shortCheckpointName(review.checkpoint||'review');
  const sourceReport = `reports/${cp}-${seq}${review.verdict==='pass'?'-pass':''}.md`;
  lines.push(`# ${titleForCheckpoint(review.checkpoint||'',review.stages)}`);
  lines.push(`source_report: ${sourceReport}`),lines.push(`verdict: ${review.verdict}`);
  lines.push(`review_request_id: ${review.reviewRequestId}`);
  if (review.round) lines.push(`round: ${review.round}`);
  lines.push('');

  const blocking = review.findings.filter(f=>f.severity==='blocking');
  const important = review.findings.filter(f=>f.severity==='important');
  const minor = review.findings.filter(f=>f.severity==='minor');

  lines.push('## 结论','');
  lines.push(`- 审查结果：${verdictLabel(review.verdict)}`);
  lines.push(`- 要改的：${blocking.length} 个`,`- 建议：${important.length} 个`,`- 其他：${minor.length} 个`);
  if (review.verdict==='pass'&&blocking.length===0) {
    lines.push('- 一句话：没发现问题，可以继续。');
  } else if (review.verdict==='revise_required') {
    const first = blocking[0];
    if (first) lines.push(`- 一句话：还不能放行。最关键的是：${oneLine(first.issue,100)}`);
    else lines.push('- 一句话：需要返修，但没标出具体要改什么，请检查审查结果。');
  } else if (review.verdict==='escalate_to_human') {
    lines.push('- 一句话：自动审查判断不了，需要人来决定。');
  }
  lines.push('');

  if (review.rootCause||review.fixApproach) {
    lines.push('## 根因与修复方向','');
    if (review.rootCause) lines.push(`**根因**：${review.rootCause}`,'');
    if (review.fixApproach) lines.push(`**修复方向**：${review.fixApproach}`,'');
  }
  if (review.resolutionSummary) lines.push('## 解决总结','',review.resolutionSummary,'');

  // slimReadSet switch: explicit per-review override wins (!== false), else config default.
  const slimReadSet = review.slimReadSet!==undefined ? review.slimReadSet!==false : readSlimReadSetEnabled();
  renderReviewerRuntimeMeta(lines, review.codexMeta);
  renderDelegatedReviewSummary(lines, review.delegatedReviewBundle, review.finalVerifierReadSet, review._delegatedPrecheck, review.rawJsonPath, slimReadSet);
  renderReviewSnapshot(lines, review.reviewSnapshot);
  renderRiskDisposition(lines, review.riskDisposition);
  renderWorktreeInventory(lines, review.worktreeInventory);
  renderVerificationResults(lines, review.verificationResults);

  if (review.skillResults?.length) {
    lines.push('## 用到的技能','','| skill | 状态 | 模式 | 证据 |','|---|---|---|---|');
    for (const sk of review.skillResults) lines.push(`| ${sk.name} | ${sk.status} | ${oneLine(sk.mode||'',30)} | ${oneLine(sk.evidence||sk.reason||'',90)} |`);
    lines.push('');
  }
  if (blocking.length) { lines.push('## 要改的',''); blocking.forEach((f,i)=>renderFindingReadable(lines,f,i)); }
  if (important.length) { lines.push('## 建议',''); important.forEach((f,i)=>renderFindingReadable(lines,f,i)); }
  if (minor.length) { lines.push('## 其他',''); minor.forEach((f,i)=>renderFindingReadable(lines,f,i)); }
  if (review.findings.length===0) lines.push('## Findings','','没有发现需要记录的问题。');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)=(.*)/); if (m) { parsed[m[1]]=m[2]; continue; }
    const b = arg.match(/^--(.+)/); if (b) parsed[b[1]]='true';
  }
  const rawPath = parsed['raw-json'];
  if (!rawPath) { console.error('Usage: render-review-report.mjs --raw-json=<path> [--stages-json=<path>]'); process.exit(2); }
  const raw = JSON.parse(readFileSync(resolve(rawPath),'utf-8'));
  const stagesPath = parsed['stages-json'];
  let stages;
  if (stagesPath&&existsSync(resolve(stagesPath))) stages=JSON.parse(readFileSync(resolve(stagesPath),'utf-8'));
  process.stdout.write(renderReviewMarkdown({
    reviewRequestId: raw.reviewRequestId||'', verdict: raw.verdict||'revise_required',
    findings: raw.findings||[], skillResults: raw.skillResults, checkpoint: raw.checkpoint||'',
    round: raw.round||1, rootCause: raw.rootCause, fixApproach: raw.fixApproach,
    resolutionSummary: raw.resolutionSummary, codexMeta: raw.codexMeta||raw._codexMeta,
    delegatedReviewBundle: raw.delegatedReviewBundle, finalVerifierReadSet: raw.finalVerifierReadSet,
    _delegatedPrecheck: raw._delegatedPrecheck, verificationResults: raw.verificationResults,
    reviewSnapshot: raw.reviewSnapshot, riskDisposition: raw.riskDisposition,
    worktreeInventory: raw.worktreeInventory, rawJsonPath: resolve(rawPath), stages,
  }));
}
if (process.argv[1] && (process.argv[1]===import.meta.filename||process.argv[1].endsWith('render-review-report.mjs'))) main();
