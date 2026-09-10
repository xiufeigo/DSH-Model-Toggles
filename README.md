# dsh-model-toggles

DSH 双面插件：把「模型能力勾选」做进官方**「设置 → 模型」页**的每个模型条目里。

在官方编辑器展开的模型条目上注入两组控件：

- **[图片输入]**：勾选 → 该模型条目写入 `input: ["text","image"]`；取消 → 删除
  `input` 字段（继承内置目录/默认值）。
- **思考强度**（最低 / 低 / 中 / 高 / 超高 / 最高 →
  `minimal / low / medium / high / xhigh / max`）：
  勾选任意档位 → 写入 `reasoningEfforts: { off:, low: low, … }`；全部取消 → 删除
  该字段。

这两项本来就是 dsh-llm-pi-ai 原生支持的配置（`input` 模态与 `reasoningEfforts`
思考档位），只是官方 UI 刻意不暴露、只能手改 `settings.yaml`：

> *"There is deliberately no reasoning-effort control, here or on the editor
> card: effort is a per-MODEL capability … The composer's model picker offers
> each model its own levels instead."*
> —— `dsh-client-ui-settings-models/lib/client.js`（0.1.5-rc.1 原文）

composer / `/model` 弹窗提供的是**为下一个请求挑档位**（只能选模型已公布的档位，
且不写回 settings）；本插件补的是**声明这个模型有哪些能力**并持久化到
`settings.yaml`。二者互补。

本插件把勾选动作自动化：**勾一下立即写盘**（settings 原子写 + schema 校验 +
热重载），无需点官方「保存」，模型选择器里该模型的图文能力与思考档位即时生效。

## 接入规范（DSH 官方插件规范，0.1.2-rc.1 起逐条核对）

| 规范 | 本插件的实现 |
|---|---|
| 包声明 `dsh.bundle.patch`，随包携带该 patch 文件 → 成为 profile 的**层** | `package.json` 的 `dsh.bundle.patch: "./cordis.patch.yml"` + 仓库根 `cordis.patch.yml` |
| 浏览器半边用 `dsh.client` 声明 | `dsh.client.platform: "web"`；导出 `./client` → `lib/client.js` |
| 安装 = `dsh plugin --profile <name> add <pkg>`（CLI 跑 pnpm 并按「依赖是否声明 `dsh.bundle`」自动重建 `dsh.profile.bundles` 层序） | `pnpm plugin:install` 委托给官方 CLI，只做构建自检 + 旧方案迁移清理 + 层序核对 |
| Host→浏览器的 RPC 走 **Connection 逻辑 channel** | `ctx.connection.rpc.handle('/dsh-model-toggles/rpc', handler)`（`inject: ['connection']`）；返回值是官方 `ConnectionRpcResult` |
| 客户端调用走官方传输 | `ctx.connection.rpc.call(channel, endpoint, payload, signal)` |
| 浏览器 bundle 是 lazy-CJS 工厂，id = 包名 | 构建 banner/footer 注册 `window.__ModuleLoader__.load({ id: "dsh-model-toggles", factory })` |
| 样式以 `style[data-plugin]` / `data-plugin-css` 归属插件 | `src/client/styles.ts` |
| 卸载随 fiber 释放 | 全部注册都包在 `ctx.effect(...)` 里 |

**因为官方已实现而删除的实现**（v0.2.0）：

- 自造安装器：两处 junction 农场 + 往 profile `cordis.patch.yml` 手写 `insert:` 行
  → 官方 `dsh plugin` 已实现（并按已安装状态重建层序）；
- 自造 RPC 传输：`webServer.register` 路由 + 自定义 `x-dsh-model-toggles` 头 +
  同源 CORS 预检闸门 + 自管请求体大小/JSON 信封
  → Connection 拥有路由挂载、Host/Origin 信任闸门、浏览器会话鉴权、
  rpcId 关联与信封校验（脚本裸访问现在得到 **401 = 已挂载且受鉴权保护**）。

## 工作原理

```
勾选 ──▶ caps.set ──▶ ① 写影子段（settings.yaml 的 model-toggles:）
                      ② 立即调和 ──▶ 写 llm-pi-ai.providers.<route>.models（原子）
官方编辑器保存 ──▶ settings 变更事件 ──▶ 兜底调和（几十 ms 内补回勾选字段）
                                    └─▶ 顺手清理影子段：已删模型/路由的影子键自动移除
启动 ──▶ 调和 + 清理各一次（修复历史覆盖、清掉旧版本遗留的无效影子键）
```

勾选状态的**事实源**是插件自己的 settings 段（`model-toggles.providers.<route>.<model>`），
不是官方编辑器的草稿。官方编辑器以「打开时的基线」做最小 path ops 保存，可能
用过期数组覆盖我们的字段；插件监听 `llm-pi-ai` 段变更后自动**调和**，把勾选
字段补回对应条目——收敛、不循环，官方保存也冲不掉。

浏览器半边**不注册任何设置 section**，只观察 DOM（`MutationObserver`）往官方
模型页注入控件；官方模型页只有 `settings.models.provider-card` /
`settings.models.footer` 两个 slot，没有「每个模型条目」的扩展点，因此这一层
只能走 DOM 注入（见「已知取舍」）。

## 使用

前置：

- DSH ≥ 0.1.2-rc.1（`ctx.connection.rpc.handle` 自该版本存在；已在 0.1.2-rc.1 与
  0.1.5-rc.1 上核对），profile 为 `web`，且 `llm-pi-ai.providers` 已配置至少一个
  提供方（模型页能列出路由）；
- 本机有 Node 20+、pnpm 与 `dsh` CLI。

安装（幂等）：

```bash
pnpm plugin:install
```

安装器依次：构建产物检查 → 冒烟自检 → `bundle 声明自检`（`dsh.bundle.patch`
存在、`dsh.client.platform === "web"`）→ 旧方案残留迁移清理 → 官方安装
`dsh plugin --profile web add link:<本仓库>` → 层序核对（`dsh.profile.bundles`
必须含 `dsh-model-toggles`）→ 尽力而为的 HTTP 验证。

常用参数：`--profile <name>`（默认 `web`）、`--spec <pnpm-spec>`（默认
`link:<仓库>`，源码改动即时生效）、`--rebuild`、`--dry-run`。

**安装后必须重启一次 DSH Desktop**。桌面部署的 dsh 进程不热重载 profile 层序
（实测：补丁/层变更在运行实例上不生效），重启后 host 半边才挂载，浏览器 bundle
由 `/plugins` combo 提供。

使用：

1. 设置 → 模型 → 点某提供方的「编辑」；
2. 展开模型条目（高级箭头，`Capacities`）；
3. 勾选「图片输入」与思考强度档位——立即写入
   `~/.dsh/settings.yaml` 的
   `llm-pi-ai.providers.<route>.models[n].{input, reasoningEfforts}`（经影子段调和）；
4. 官方编辑器的「保存」可照常使用，勾选不会被它冲掉。

写盘效果示例（settings.yaml）：

```yaml
model-toggles:
  providers:
    openrouter:
      stealth/ox-alpha:
        image: true
        efforts: [high, max]
llm-pi-ai:
  providers:
    openrouter:
      models:
        - id: stealth/ox-alpha
          input: [text, image]
          reasoningEfforts:
            off:
            high: high
            max: max
```

卸载：

```bash
pnpm plugin:uninstall
```

委托 `dsh plugin --profile web remove dsh-model-toggles`（本包自动退出层序），
并幂等清理旧方案残留。卸载只移除层与解析链接，**不**清理已生效的配置：需要时
手工删除 settings.yaml 里的 `model-toggles:` 段，以及模型条目里由插件写入的
`input` / `reasoningEfforts` 字段。

## 语义细节

- 取消勾选 = **受管关闭**：影子层写 `image: false` / `efforts: []`，调和时删除
  对应字段 —— 不是「恢复原样」，而是「确保无此能力」。想彻底回到「跟随内置
  目录」，删掉影子段对应键即可让字段随默认值。
- **不复活删除，影子随删自动清**：事件驱动的兜底调和在引擎层缺省
  `allowCreate=false`（调用方漏传也绝不复活）；只有显式勾选（caps.set 的立即
  调和，`allowCreate=true` 且 `createIds` 限定为本次勾选的目标）才允许创建缺失
  条目/接管目录。官方编辑器里删除模型/路由后，清理在「官方保存触发的调和 /
  启动调和 / caps.set 立即调和」时执行——路由被删清整段、模型不在显式列表清单
  键、空覆盖一并清；无显式 `models:` 列表的路由（跟随内置目录）无法凭列表判定
  删除，非空影子键保留。影子段自身变更的事件只调和不清理（防误删刚写入、尚未
  调和成功的键）。影子段因此无需人工维护；代价是重新添加同 id 模型时不再恢复
  之前的勾选（记忆已随删除自动清理）。
- `off` 档位恒写入为 `off:`（null = 支持关闭思考、不发参数）：一旦声明任何思考
  档位，若不保留 off，该模型将无法显式关闭思考。dsh-llm-pi-ai 的解析规则是
  `null` 只允许出现在 `off` 上，且空 `reasoningEfforts` / 只有 `off` 会被拒绝
  —— 本插件的「全部取消 = 删字段」正好避开这两种非法形状。
- 勾选目标 = 条目在**已保存**配置里的模型 id（服务端强制）：官方编辑器里临时
  改名/新增的模型（未保存进 models 列表）勾选会被拒绝并提示先保存 —— 防止
  插件写入裸条目、与官方保存的插入操作撞出重复 id（重复会让调和器的条目校验
  永久报错）；保存后重新打开即可勾选。
- 未写 `models:` 列表的路由（直接使用内置目录）：第一次显式勾选会以「内置目录
  全量 passthrough（保留 name / 容量字段）+ 勾选条目」接管为显式列表；接管后
  内置目录日后的更新不会自动出现（需手工同步或删除 models 列表恢复）。目录
  装载为懒加载（ensureCatalog，调和前必等待），但**只认「路由键 = pi-ai 内置
  provider 名」的路由**；自定义路由键目录不可知 → 拒绝接管并提示先添加模型。
  caps.get 对目录路由回退内置目录，能力显示不为空。
- 快速连续勾选同一模型的两个维度时，客户端按 (route, model) 串行提交，不会
  互相覆盖；RPC 带 15s 超时，挂起请求不会卡死串行队列。写入失败时客户端强制
  回读服务端真相，勾选框自动复位（不停留在用户点击后的假状态）。

## 结构

```
cordis.patch.yml      本包的 profile 层（dsh.bundle.patch 指向它）—— 官方安装时
                      由 dsh plugin 自动并入 dsh.profile.bundles
src/capabilities.ts   纯逻辑：efforts 形状 / 有效状态 / 合并（接管、受管关闭、幂等、
                      不复活）/ 影子段清理计划（随删自动清、目录路由不误清）/
                      目录条目字段保留转换（catalogEntriesOf）
src/index.ts          Host：Connection channel handler（meta.routes / caps.get /
                      caps.set）+ 影子段 + 调和引擎
src/client/inject.ts  DOM 注入层（aria-label/类名子串锚点，防御式、幂等）
src/client/index.tsx  浏览器半边：按路由完整能力快照缓存 + token 失效保护 + MutationObserver
src/client/rpc.ts     ctx.connection.rpc.call 薄封装（端点名 + 15s 超时）
scripts/smoke.mjs     冒烟：两个 bundle 真实求值 + 逻辑单测 + channel handler 写入/收敛/复活防护直测
scripts/dom-test.mjs  jsdom 集成：按官方编辑器真实 DOM 形状直测注入与上报
scripts/client-state-test.mjs 两模型同路由状态回归：事件失效 + caps.set 不得截断缓存
scripts/verify-live.mjs 重启后一键活实例验证（只读）
scripts/check-shadow.mjs 影子段核对：解析 settings.yaml，报告指向不存在路由/模型的
                      无效键（目录 passthrough 路由跳过模型级核对）
scripts/legacy.mjs    旧安装方案（junction + profile 手写行）的幂等迁移清理
scripts/install.mjs   安装器（构建自检 + bundle 声明自检 + 迁移清理 + 官方 CLI + 层序核对）
scripts/uninstall.mjs 卸载器（官方 CLI remove + 迁移清理）
```

## 开发与自测

```
pnpm build          # tsdown 双面构建（host ESM + client CJS + 纯逻辑产物）
pnpm typecheck      # tsc --noEmit
pnpm verify            # 冒烟 34 项（含 Connection 契约/写入/收敛/复活防护/影子自动清理/目录接管）
pnpm test:dom          # jsdom DOM 集成 7 项
pnpm test:client-state # 两模型同路由缓存回归（防止「勾一个另一个失效」）
pnpm test              # typecheck + verify + test:dom + test:client-state 四连
pnpm verify:live       # 活实例只读验证（需 DSH 已重启加载本插件）
                       # 脚本无会话 cookie 时 RPC 探测得 401 = channel 已挂载且
                       # 鉴权生效（这是期望）；传 `?token=` 的 URL 或设
                       # DSH_WEB_COOKIE 可做完整业务验证
```

自测期间发现并修复过的真实问题（回归测试均在案）：dataset 连字符属性名
（浏览器会抛异常）、注入层全局 document 依赖、调和器「复活」被删除路由/模型的
缺陷（含事件调和漏传 `allowCreate` 被当成 true、官方编辑器每次保存都会把影子段
里已删除的模型按裸条目复活的接线 bug）、`ensureCatalog` 从未被调用导致目录接管
在生产恒失败的死接线、影子段自身变更事件触发清理会误删「刚写入、尚未调和成功」
的键、显示名撞名时勾选写错路由、未保存模型勾选可产生重复 id 条目，同一路由
单模型 `caps.set` 响应截断完整能力缓存、导致「勾一个另一个失效」的竞态，以及
调和器读条目时剥掉非受管字段、整写 models 数组把用户在官方编辑器保存的
contextWindow / maxTokens 一并抹掉的「上下文窗口丢失」。

规范要点：host 半边 `inject: ['connection']`（channel 归属本 fiber，随卸载释放）、
settings 走 `ctx.inject(['settings'])` 可选依赖；`@deepseek-ai/*` 与
`@earendil-works/pi-ai` 保持 external（与运行时共享实例，pi-ai 为懒加载）；
client 半边只 external react 家族、其余全内联、CJS 工厂经 `__ModuleLoader__`
注册；样式 `style[data-plugin]` 卸载清理。

## 已知取舍

- 界面锚点依赖官方编辑器结构（CSS-module 类名子串 + aria-label）。上游大改
  DOM 时勾选可能不出现 —— 属非破坏性降级，更新锚点即可恢复。已在
  0.1.2-rc.1 → 0.1.5-rc.1 上逐锚点核对：`modelEntry` / `modelRow` /
  `modelAdvanced` / `editorRoute` / `editorTitle` / `rowName` / `rowCard` /
  `setupCard` / 哈希前缀 `zGbnIq_` 全部未变（`modelAdvanced` 仍是 `modelEntry`
  的直接子节点）。**没有官方「每个模型条目」的 slot**，所以这层只能 DOM 注入。
- 路由解析依赖「显示名 → 路由键」目录（host 从 settings 实时提供）；显示名与
  路由键相同且无 editorRoute 文本时按显示名兜底。两个提供方同名时按歧义处理
  （不注入、不写错路由）。
- RPC 鉴权交给 Connection（Host/Origin 信任闸门 + 浏览器会话 cookie）：本机
  单用户下的威胁模型与「本机进程可直改 settings.yaml」同级。
- 桌面部署必须重启 DSH 才生效（不热重载 profile 层序）；headless/CLI 每次启动
  即生效（诊断日志 `~/.dsh/dsh-model-toggles.apply.log` 可见 apply 三阶段：
  `apply-enter` → `connection-ok` → `channel-registered`）。
- 接管语义（见上）：目录型路由一旦写显式 models 列表即脱离内置目录的自动更新。
- 插件 bundle 是 combo 形态
  （`/plugins/??<id>/client.js&rev=<每次启动的随机 rev>`，单文件形态不再应答）；
  浏览器经 boot graph 拿 combo URL 加载，`verify-live` 需要读首页 graph，
  匿名运行时该项自动降级为跳过。
