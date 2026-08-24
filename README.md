# dsh-model-toggles

DSH 双面插件：把「模型能力勾选」做进官方**「设置 → 模型」页**的每个模型条目里。

在官方编辑器展开的模型条目上注入两组控件：

- **[图片输入]**：勾选 → 该模型条目写入 `input: ["text","image"]`；取消 → 删除
  `input` 字段（继承内置目录/默认值）。
- **思考强度**（低 / 中 / 高 / 超高 / 最高 → `low / medium / high / xhigh / max`）：
  勾选任意档位 → 写入 `reasoningEfforts: { off:, low: low, … }`；全部取消 → 删除
  该字段。

这两项本来就是 dsh-llm-pi-ai 原生支持的配置（`input` 模态与 `reasoningEfforts`
思考档位），只是官方 UI 没暴露、只能手改 `settings.yaml`。本插件把勾选动作
自动化：**勾一下立即写盘**（settings 原子写 + schema 校验 + 热重载），
无需点官方「保存」，模型选择器里该模型的图文能力与思考档位即时生效。

## 工作原理

```
勾选 ──▶ caps.set ──▶ ① 写影子段（settings.yaml 的 model-toggles:）
                      ② 立即调和 ──▶ 写 llm-pi-ai.providers.<route>.models（原子）
官方编辑器保存 ──▶ settings 变更事件 ──▶ 兜底调和（几十 ms 内补回勾选字段）
```

勾选状态的**事实源**是插件自己的 settings 段（`model-toggles.providers.<route>.<model>`），
不是官方编辑器的草稿。官方编辑器以「打开时的基线」做最小 path ops 保存，可能
用过期数组覆盖我们的字段；插件监听 `llm-pi-ai` 段变更后自动**调和**，把勾选
字段补回对应条目——收敛、不循环，官方保存也冲不掉。

## 使用

前置：

- DSH profile 为 `web`（`~/.dsh/profiles/web`），且 `llm-pi-ai.providers` 已配置
  至少一个提供方（模型页能列出路由）；
- 本机有 Node 20+ 与 pnpm。

安装（幂等）：

```bash
pnpm plugin:install
```

安装器会依次：`pnpm install` → 构建 → 冒烟自检 → 在 `~/.dsh/profiles/node_modules`
与 `~/.dsh/profiles/web/node_modules` 创建指向本项目的 junction → 向
`cordis.patch.yml` 追加插件行 → 尽力而为的 HTTP 验证。

**安装后必须重启一次 DSH Desktop**。桌面部署的 dsh 进程不热重载
`cordis.patch.yml`（实测：补丁变更在运行实例上不生效），重启后 host 半边才挂载，
浏览器 bundle 由 `/plugins/dsh-model-toggles/client.js` 提供。

使用：

1. 设置 → 模型 → 点某提供方的「编辑」；
2. 展开模型条目（高级箭头）；
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

卸载只移除 patch 行与 junction，**不**清理已生效的配置：需要时手工删除
settings.yaml 里的 `model-toggles:` 段，以及模型条目里由插件写入的
`input` / `reasoningEfforts` 字段。

## 语义细节

- 取消勾选 = **受管关闭**：影子层写 `image: false` / `efforts: []`，调和时删除
  对应字段 —— 不是「恢复原样」，而是「确保无此能力」。想彻底回到「跟随内置
  目录」，删掉影子段对应键即可让字段随默认值。
- **不复活删除**：只有显式勾选（caps.set 的立即调和，`allowCreate=true`）才允许
  创建缺失条目/接管目录；`llm-pi-ai` 变更触发的事件调和
  （`allowCreate=false`）只修改仍在列表里的条目——你在官方编辑器里删除的路由/
  模型绝不会被插件加回来。反向：重新添加同 id 的模型时，之前勾选过的能力
  会自动恢复（影子段按模型 id 记忆）。
- `off` 档位恒写入为 `off:`（null = 支持关闭思考、不发参数）：一旦声明任何思考
  档位，若不保留 off，该模型将无法显式关闭思考。
- 勾选目标 = 条目在**已保存**配置里的模型 id；官方编辑器里临时改名/新增的
  模型，保存后重新打开即可勾选。
- 未写 `models:` 列表的路由（直接使用内置目录）：第一次显式勾选会以「内置目录
  全量 passthrough + 勾选条目」接管为显式列表；接管后内置目录日后的更新不会
  自动出现（需手工同步或删除 models 列表恢复）。
- 快速连续勾选同一模型的两个维度时，客户端按 (route, model) 串行提交，不会
  互相覆盖。

## 结构

```
src/capabilities.ts   纯逻辑：efforts 形状 / 有效状态 / 合并（接管、受管关闭、幂等、不复活）
src/index.ts          Host：RPC（meta.routes / caps.get / caps.set）+ 影子段 + 调和引擎
src/client/inject.ts  DOM 注入层（aria-label/类名子串锚点，防御式、幂等）
src/client/index.tsx  浏览器半边：按路由完整能力快照缓存 + token 失效保护 + MutationObserver
scripts/smoke.mjs     冒烟：两个 bundle 真实求值 + 逻辑单测 + RPC 写入/收敛/复活防护直测
scripts/dom-test.mjs  jsdom 集成：按官方编辑器真实 DOM 形状直测注入与上报
scripts/client-state-test.mjs 两模型同路由状态回归：事件失效 + caps.set 不得截断缓存
scripts/verify-live.mjs 重启后一键活实例验证（只读）
scripts/install.mjs   安装器（构建+冒烟+junction+patch 行+HTTP 验证）
scripts/uninstall.mjs 卸载器（patch 行+junction）
```

## 开发与自测

```
pnpm build          # tsdown 双面构建（host ESM + client CJS + 纯逻辑产物）
pnpm typecheck      # tsc --noEmit
pnpm verify            # 冒烟 21 项（含 RPC 写入/收敛/复活防护）
pnpm test:dom          # jsdom DOM 集成 7 项
pnpm test:client-state # 两模型同路由缓存回归（防止「勾一个另一个失效」）
pnpm test              # typecheck + verify + test:dom + test:client-state 四连
pnpm verify:live       # 活实例只读验证（需 DSH 已重启加载本插件）
```

自测期间发现并修复过的真实问题（回归测试均在案）：dataset 连字符属性名
（浏览器会抛异常）、注入层全局 document 依赖、调和器「复活」被删除路由/模型的
缺陷，以及同一路由单模型 `caps.set` 响应截断完整能力缓存、导致「勾一个另一个
失效」的竞态。

规范要点：host 半边硬 inject `webServer`（冷启动等就绪）、settings 走
`ctx.inject(['settings'])` 可选依赖；`@deepseek-ai/*` 与 `@earendil-works/pi-ai`
保持 external（与运行时共享实例，pi-ai 为懒加载）；client 半边只 external
react 家族、其余全内联、CJS 工厂经 `__ModuleLoader__` 注册；样式
`style[data-plugin]` 卸载清理；RPC 自定义头跨站闸门（同 dsh-explorer 约定）。

## 已知取舍

- 界面锚点依赖官方编辑器结构（CSS-module 类名子串 + aria-label）。上游大改
  DOM 时勾选可能不出现 —— 属非破坏性降级，更新锚点即可恢复。
- 路由解析依赖「显示名 → 路由键」目录（host 从 settings 实时提供）；显示名与
  路由键相同且无 editorRoute 文本时按显示名兜底。
- 桌面部署必须重启 DSH 才生效（不热重载 profile 补丁）；headless/CLI 每次启动
  即生效（诊断日志 `~/.dsh/dsh-model-toggles.apply.log` 可见 apply 三阶段）。
- 接管语义（见上）：目录型路由一旦写显式 models 列表即脱离内置目录的自动更新。