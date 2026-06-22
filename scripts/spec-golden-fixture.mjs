#!/usr/bin/env node
// spec-golden-fixture.mjs — Phase 3 T015 golden fixture (旧 spec 兼容回归守护).
//
// 目的:T014 给 spec-template.md 纯增了三个新 section(速读卡 / 状态覆盖清单 / 分层)。
// 必须保证旧 spec(没有这些新 section)在 design-reviewer 的硬规则下仍然全 PASS,
// 即新 section 是「可选」而非「必需」。否则 T014 就成了一次破坏旧 spec 兼容的改动。
//
// 派生逻辑(关键,非空 grep):旧 spec 必需元素来自 design-reviewer-contract.md
// line 104-105 的硬规则:
//   line 104  场景覆盖完整 | 检查 ≥8 个用户/边界/失败/权限场景;每个 FR 至少一个 Given/When/Then
//   line 105  FR 编号规范  | grep `FR-[A-Z]+-[0-9]{3}`,禁止 `FR-001` 平铺编号
// 外加 frontmatter/元数据头(spec 顶部权威源/元信息块,两份旧 spec 共有的最松形态)。
//
// 检查项(对每份旧 spec):
//   C1 场景 ≥8        — §3「用户场景」区块内,两种格式取并集(有序列表 `N.` + `### 场景X`)
//   C2 FR 编号规范    — 命中若干 `FR-[A-Z]+-[0-9]{3}`,且无平铺 `FR-001`
//   C3 验收三元组     — spec 级:§3 场景区有 ≥8 组 Given/When/Then 或等价验收(不强求逐 FR)
//   C4 frontmatter    — 标题 `# …` + 顶部 `>` 元数据/权威源块(最松,两份都满足)
//
// 判别力:新 section(速读卡/状态覆盖)显式当「可选」——旧 spec 没有也 PASS,只记一行
// optional 状态。脚本末尾内置负向对照(剥掉每个必需元素 → 必须 FAIL),证明 C1-C4 有判别力。
//
// 用法:node spec-golden-fixture.mjs   (无参数,跑内置两份旧 spec + 负向对照自检)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/core/agenthub/skills/3rd-review/scripts -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');

const OLD_SPECS = [
  path.join(REPO_ROOT, 'specs/archive/ns1-loss-attribution-signal-stability/spec.md'),
  path.join(REPO_ROOT, 'specs/intake-workflow-hardening/spec.md'),
];

// 新 section 显式列为可选:旧 spec 缺它们绝不 FAIL。
const OPTIONAL_SECTIONS = [
  { name: '速读卡', test: (t) => /^##\s+速读卡/m.test(t) },
  { name: '状态覆盖清单', test: (t) => t.includes('状态覆盖清单') },
];

const SCENARIO_MIN = 8;

// ── 把 spec 切出 §3「用户场景」区块,避免数到第 9 章的 `1. 不做…` 等无关编号 ──
function extractScenarioSection(text) {
  // §3 标题:`## 3. 用户场景…`(允许标题文字变体)。截到下一个 `## ` 顶级章节。
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+\d*\.?\s*用户场景/.test(lines[i]) || /^##\s+\d+\.\s*用户场景/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\d/.test(lines[i]) || /^##\s+[^#]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

// C1: 场景数 — 两种格式取并集,限定 §3 区块。
function countScenarios(scenarioSection) {
  if (!scenarioSection) return 0;
  const headerStyle = (scenarioSection.match(/^###\s*场景/gm) || []).length;
  // 有序列表风格:行首 `N. **…**`(ns1 的场景都带 **加粗标题**,过滤纯说明编号)。
  const listStyle = (scenarioSection.match(/^\s*\d+\.\s+\*\*/gm) || []).length;
  return headerStyle + listStyle;
}

// C3: 验收三元组 — spec 级,在 §3 数 Given/When/Then。
// 两份旧 spec 的 G/W/T 都落在场景区(不在 FR 下),故 spec 级数,不强求逐 FR。
function countGwt(scenarioSection) {
  if (!scenarioSection) return 0;
  // 一组三元组:同一段里 Given … When … Then 顺序出现。逐场景近似:数 Given/When/Then 各自出现次数取下界。
  const g = (scenarioSection.match(/Given/g) || []).length;
  const w = (scenarioSection.match(/When/g) || []).length;
  const t = (scenarioSection.match(/Then/g) || []).length;
  return Math.min(g, w, t);
}

// C2: FR 编号规范。
function checkFrNumbering(text) {
  const domainScoped = text.match(/FR-[A-Z]+-[0-9]{3}/g) || [];
  // 平铺 `FR-001`(域缩写缺失):FR- 后直接数字。
  const flat = text.match(/FR-[0-9]{3}/g) || [];
  return { hits: domainScoped.length, flat: flat.length };
}

// C4: frontmatter / 元数据头(最松):标题 + 顶部 `>` 元数据块。
function checkFrontmatter(text) {
  const lines = text.split('\n');
  const hasTitle = lines.some((l) => /^#\s+\S/.test(l));
  // 顶部 30 行内出现 `>` 引用块(权威源/change_id/元信息)。
  const top = lines.slice(0, 30);
  const hasMetaBlock = top.some((l) => /^>\s*\S/.test(l));
  return hasTitle && hasMetaBlock;
}

// ── 跑一份 spec 的全部硬检查 ──
function runChecks(text) {
  const scenarioSection = extractScenarioSection(text);
  const scenarioCount = countScenarios(scenarioSection);
  const gwt = countGwt(scenarioSection);
  const fr = checkFrNumbering(text);
  const fmOk = checkFrontmatter(text);

  const checks = [
    {
      id: 'C1',
      name: `场景 ≥${SCENARIO_MIN}`,
      pass: scenarioCount >= SCENARIO_MIN,
      detail: `场景数=${scenarioCount}(阈值 ≥${SCENARIO_MIN})`,
    },
    {
      id: 'C2',
      name: 'FR 编号规范 FR-[A-Z]+-[0-9]{3} 且无平铺',
      pass: fr.hits > 0 && fr.flat === 0,
      detail: `域缩写编号命中=${fr.hits},平铺 FR-NNN=${fr.flat}`,
    },
    {
      id: 'C3',
      name: '验收三元组 Given/When/Then(spec 级 ≥8)',
      pass: gwt >= SCENARIO_MIN,
      detail: `G/W/T 三元组下界=${gwt}(阈值 ≥${SCENARIO_MIN})`,
    },
    {
      id: 'C4',
      name: 'frontmatter/元数据头存在',
      pass: fmOk,
      detail: fmOk ? '标题 + 顶部 > 元数据块均在' : '缺标题或元数据块',
    },
  ];
  return checks;
}

function reportSpec(specPath) {
  const rel = path.relative(REPO_ROOT, specPath);
  if (!fs.existsSync(specPath)) {
    console.log(`\n=== ${rel} ===`);
    console.log('  FAIL — 文件不存在');
    return false;
  }
  const text = fs.readFileSync(specPath, 'utf8');
  const checks = runChecks(text);
  const allPass = checks.every((c) => c.pass);

  console.log(`\n=== ${rel} ===`);
  console.log(`  结果: ${allPass ? 'PASS' : 'FAIL'}`);
  for (const c of checks) {
    console.log(`    [${c.pass ? '✓' : '✗'}] ${c.id} ${c.name} — ${c.detail}`);
  }
  // 新 section:可选,缺失不 FAIL,只记状态。
  for (const sec of OPTIONAL_SECTIONS) {
    const present = sec.test(text);
    console.log(`    [opt] 新 section「${sec.name}」: ${present ? 'present' : 'absent (OK，可选)'}`);
  }
  if (!allPass) {
    const missing = checks.filter((c) => !c.pass).map((c) => `${c.id}(${c.name})`).join('、');
    console.log(`    缺失: ${missing}`);
  }
  return allPass;
}

// ── 负向对照自检:证明 C1-C4 有判别力(剥掉某元素 → 必须 FAIL) ──
function negativeControls(baselineText) {
  console.log('\n=== 负向对照自检(判别力证明) ===');
  const cases = [
    {
      name: 'C1 剥场景(删 §3 全部场景标题/列表)',
      mutate: (t) => {
        const sec = extractScenarioSection(t);
        if (!sec) return t;
        const stripped = sec
          .replace(/^###\s*场景.*$/gm, '(removed)')
          .replace(/^\s*\d+\.\s+\*\*.*$/gm, '(removed)');
        return t.replace(sec, stripped);
      },
      expectCheck: 'C1',
    },
    {
      name: 'C2 平铺编号(把 FR-XXX-NNN 换成 FR-001)',
      mutate: (t) => t.replace(/FR-[A-Z]+-[0-9]{3}/g, 'FR-001'),
      expectCheck: 'C2',
    },
    {
      name: 'C3 剥 Given/When/Then',
      mutate: (t) => t.replace(/Given|When|Then/g, '_'),
      expectCheck: 'C3',
    },
    {
      name: 'C4 剥 frontmatter(删标题 + 顶部 > 块)',
      mutate: (t) =>
        t
          .split('\n')
          .map((l, i) => (i < 30 && (/^#\s+\S/.test(l) || /^>\s*\S/.test(l)) ? '(removed)' : l))
          .join('\n'),
      expectCheck: 'C4',
    },
  ];

  let allDiscriminate = true;
  for (const c of cases) {
    const mutated = c.mutate(baselineText);
    const checks = runChecks(mutated);
    const target = checks.find((x) => x.id === c.expectCheck);
    const failed = target && !target.pass;
    if (!failed) allDiscriminate = false;
    console.log(`    [${failed ? '✓' : '✗'}] ${c.name} → 期望 ${c.expectCheck} FAIL: ${failed ? '已 FAIL(有判别力)' : '仍 PASS(判别力缺失!)'}`);
  }
  return allDiscriminate;
}

function main() {
  console.log('# spec-golden-fixture — 旧 spec 兼容回归守护');
  console.log('# 派生源: design-reviewer-contract.md line 104-105(场景≥8 / FR编号 / G-W-T)+ frontmatter 最松项');

  let allSpecsPass = true;
  for (const specPath of OLD_SPECS) {
    const pass = reportSpec(specPath);
    allSpecsPass = allSpecsPass && pass;
  }

  // 负向对照用第一份旧 spec(已知 PASS)做基线变异。
  const baseline = fs.existsSync(OLD_SPECS[0]) ? fs.readFileSync(OLD_SPECS[0], 'utf8') : '';
  const discriminates = baseline ? negativeControls(baseline) : false;

  console.log('\n=== 总结 ===');
  console.log(`  旧 spec 全 PASS: ${allSpecsPass ? '是' : '否'}`);
  console.log(`  负向对照判别力: ${discriminates ? '全部生效' : '存在失效'}`);

  const ok = allSpecsPass && discriminates;
  console.log(`\n# 最终: ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

main();
