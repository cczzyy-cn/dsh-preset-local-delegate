# 新会话交接单 — 开工三步

> 历史（每轮的完整过程、测量、踩坑原因）在 [`HISTORY.md`](HISTORY.md)，按时间倒序，**那里的数字是当时的值**。
> 本文件只放：当前状态、下一步、以及"哪一步会怎么骗你"。

## 0. 现在是什么状态（2026-10-18）

| 项 | 值 | 怎么确认 |
|---|---|---|
| 模型 | **qwen3.8-flash-next-iq3_xxs**（约 3-bit 通用；2026-10-16 从 IQ3_S 换过来，省 6.9 GiB） | `node scripts/doctor.mjs` |
| 引擎 | Strata **0.1.44.1**，`max_context` **262144**、`images: true` | 同上（`/health`） |
| 输出上限 | profile `maxTokens` **32768**（提示词硬上限 = 262144 − 32768 = 229376） | profile `cordis.patch.yml` |
| 推理档位 | **`low`**（引擎 shared 默认）。**不要调回 `none`**：多步算术会静默算错（9/18 vs 18/18） | `/settings` |
| 采样 | greedy，且 `<config>.shared-settings.json` **不能**带 temperature | 同上 |
| preset 指纹 | `local-delegate.mjs` `F145FC63F896DE15`（126,572 B） | `Get-FileHash` |
| 自检 | **233 passed, 0 failed**（没引擎也能跑） | `node local-delegate.selftest.mjs` |
| 工具链 | 在**本仓库** `tools/`（10 个文件，2026-10-18 从隔壁仓库收进来并入库） | `git ls-files tools` |
| 引擎状态 | ⚠️ **8080 现在没在跑**（2026-10-18 实测拒连） | `curl 127.0.0.1:8080/health` |

## 1. 开工三步

```powershell
node scripts/doctor.mjs              # 一条命令：进程 vs 文件、硬链接、引擎、模型 id、preset、死路由
node local-delegate.selftest.mjs     # 233 passed, 0 failed
node scripts/check-docs.mjs          # 文档里的数字 == 实际
```

`doctor` 的每条 FAIL 后面都写着 → 下一步。**先信它，再信记忆。**

## 2. 现在真正待办（按顺序）

1. **重启 DSH 本体** —— 当前进程起于 14:20:16，而预设在 14:23:14 才修好（`{{cwd}}` 那行）。不重启，新建会话仍会报
   `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`。`doctor` 的
   *"the running DSH is newer than its config"* 就是这条。
2. **起本地引擎** —— 8080 拒绝连接时，`delegate_batch` 会以误导性的 `invalid JSON` 收场。
3. **push** —— 本地领先 `origin/main` 若干提交；push 前先决定父仓库的 `tools/` 是否也要入库（见 §5）。
4. 重跑 `doctor`，期望 `READY`。

## 3. 验收这条链（全绿才算完）

```powershell
node --check local-delegate.mjs
node local-delegate.selftest.mjs                       # 233 passed
node scripts/check-docs.mjs                            # DOCS MATCH THE TREE
node scripts/verifier-matrix.mjs                       # 36 cases / 16 kinds，全绿
node scripts/sync-install.mjs --check                  # up to date
node scripts/doctor.mjs                                # READY
python tools\build-local-delegate-preset.py --selftest # 3 passed（{{cwd}} 守卫）
python tools\build-local-delegate-preset.py --check    # up to date
python tools\validate-preset-bundle.py .               # valid
python tools\check-profile-roster.py                   # OK: 5 presets
node tools\session-headers.mjs --preset hybrid-router --blank   # 0
```

## 4. 坑速查（每条都真花过时间）

| 现象 | 真相 | 处置 |
|---|---|---|
| 改完模块、也 install 了，还没生效 | 模块**每进程加载一次**；pnpm 按 manifest 键控，不看内容 | `sync-install` + **重启 DSH**；用行为探针分辨，不看 GUIDE |
| `sync-install --check` 说 same，线上却还是旧的 | profile 里的 `cordis.patch.yml` 与源码是**硬链接**（同 inode，`nlink=2`） | 现在会单独报 `linked`；`--force-copy` 恢复普通副本，`--link` 主动建链接。**只有重启**能让进程看到 |
| 委派被拒 `route … is not allowed` | 进程里的 `LOCAL_MODEL` 与 profile 的允许列表不一致 | 换模型 = 引擎 + profile 路由 + module 默认值 + compaction 策略；`engine-profile.json` 是唯一源 |
| 每个新会话都起不来，且**没有 transcript** | persona 模板引用了未注册的 `{{…}}`（如 `{{cwd}}`） | 生成器会拒绝；`doctor` 也会报 |
| 委派结果"偷偷被采样" | `<config>.shared-settings.json` 被 Chat 页写入了 temperature | 那个文件只留 `reasoning_effort` |
| 长输入退化成逐字复读 | 引擎从不截断：`prompt+maxTokens` 超窗口直接 400；或模型在长输入下循环 | 切开 / 用 `files:` / 改写任务，别重发 |
| `npm test` 报 engine unreachable | 旧行为；现在默认离线可跑 | 想强制要引擎：`DSH_REQUIRE_ENGINE=1` |

## 5. 目录与边界

- `tools/` —— 生成与取证（10 个文件）：generator / dumper / validator / roster / asar-read / `session-*` / vision-check。
  **都从仓库根跑**，不再 `cd ..`。
- `scripts/` —— 运行时运维：`doctor` / `check-docs` / `verifier-matrix` / `ledger` / `sync-install` / `subagent-trace`。
- `docs/verifier-matrix.md` —— **生成物**（`npm run matrix:write`）：16 个 kind 的阳性/近失矩阵；`check-docs` 会验它是否过期。
- `engine-profile.json` —— 唯一引擎事实源；**换模型只改这里 + profile patch**，然后 `check-docs`。
- `HISTORY.md` —— 历史。追某个结论的出处时去那里，不要用它的数字验收今天。
- 父仓库 `git/Strata/tools/` 里还剩 `conversation_growth_needle.py` 等**引擎侧**工具仍未入库；
  本仓库的 10 个已经入库。要不要把引擎侧的也收，是独立决定。
