# 审查员验证门禁（防绕过，FR-REVIEW-012）

> 本文件由 3rd-review SKILL.md 薄壳引用，主会话不读，审查员/脚本/gate 按需读。

## 审查员验证门禁（防绕过）

reviewer_output gate 通过 reviewer-proof 注册表核查审查执行证据。**已知架构限制（FR-REVIEW-012）**：codex / claude 两条路径均为全局目录扫描，主 agent 自身会话即可满足绑定，防不住 orchestrator 造假。因此：

- **Path 1+2（codex / claude，已注册验证器）**：verification 失败为非阻断诊断（`console.warn`，workflow 继续）。
- **Path 3（unknown provider，无注册验证器）**：保留 `exit 2` fail-closed——真实 config error，非防伪漏洞。

唯一真正的机器防伪强制是 AJV schema（约束 3）。详见防伪声明小节和 `workflow-gate.ts:2937`。
