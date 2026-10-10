---
description: "完整的 V3 到 V4 会话转换：仅头部重盖章，新增可选的按用户 owner，所有事件行与继承切点原样通过。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-format-v3-to-v4

[English](README.md) | 中文

## 概述

将受支持的已发布 V3 会话恢复为 V4，不改变任何事件、序列位置、时间戳或继承切点。本页是这条相邻边的唯一规范：它转换什么、保留什么、拒绝什么，随后单独说明原生 V4 准入。唯一的结构新增是头部可选 `owner`，即为按用户 Web 登录后创建的会话盖章的按用户主体。持久化通过静态目录消费本库；本库不读取或发布文件。

## 目录

- [使用本包](#use-this-package)
- [V3 到 V4 规范](#v3-to-v4-specification)
  - [头部重盖章](#header-restamp)
  - [事件透传与继承切点](#event-passthrough)
- [原生 V4 准入](#native-v4-admission)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

使用[目录](../session-format-catalog/README.zh.md)恢复会话。直接导入服务于目录组装与测试；本库没有 Cordis 挂载配置。[公开导出](src/index.ts)提供迁移声明、已发布 V3 源编解码器再导出、V4 目标编解码器、目标头部校验器与目标恢复器。

### 入口

仅头部操作不转换也不校验事件体：

```text
const targetHeader = sessionFormatV3ToV4.migrateHeader(sourceHeader)
```

完整恢复将解码后的事件送入新的阶段并校验目标产物。调用方不得把阶段的部分输出视为成功恢复：错误可能出现在后续事件或 `finish()`。[格式协议](../session-format/README.zh.md)拥有阶段调度与目录错误处理；[JSONL 持久化](../session-persistence-jsonl/README.zh.md)拥有读取准备与不可变后继发布。

-----

<a id="v3-to-v4-specification"></a>
## V3 到 V4 规范

这条完整的边对事件是恒等转换。它保留每个源事件的相对顺序、密集序列位置、时间戳、负载与继承切点。只有头部版本改变；保留适用于被准入的输入，而非任意未审计的扩展。

<a id="header-restamp"></a>
### 头部重盖章

逻辑头部将 `version: 3` 改为 `version: 4`。它原样保留 `id`、`createdAt`、`isSeeded`、`delegationDepth` 与被准入的可选字段。已发布 V3 头部从不携带 `owner`；因此迁移从不凭空发明它，迁移得到的 V4 头部在原生 V4 写入方盖章之前没有 `owner`。未通过已发布 V3 校验的源头部在重盖章前被拒绝。

<a id="event-passthrough"></a>
### 事件透传与继承切点

每个源事件原样发出，包括当前写入方已淘汰但冻结 V3 编解码器仍准入的行。紧凑运行展开后透传，不做逐事件检查。

对于播种会话，最后一个带有 `data.inherited: true` 的 `session/end-seed` 标识源切点；其源序列即继承事件数，不含该标记本身。未标记的标记不确立切点。提供的 `sourceInheritedEventCount` 必须一致；无标记的播种日志与带标记的未播种日志均被拒绝。未播种阶段暴露 `headerInheritedEventCount: 0`；播种阶段在 `finish()` 推导确切切点之前保持未知。这与前一条边的切点语义一致，因此 V0/V1/V2 链到达 V4 时保持其在 V3 时的继承前缀。

-----

<a id="native-v4-admission"></a>
## 原生 V4 准入

已标记 V4 的输入不运行 V3 到 V4。使用 `validation: 'transformed'` 的原生目录读取只应用编解码器检查；完整关系需要 `restoreReleasedV4Artifact` 或目录 `validation: 'current'`。以下规则区分 V4 检查与其委托的冻结 V3 规则：

- V4 逻辑头部恰好准入已发布 V3 字段加可选 `owner`。提供的 `owner` 必须是字符串；任何其他值被拒绝。owner 不参与任何事件关系，恢复返回的产物保持 owner 不变。
- 物理 V4 头部在冻结 V3 校验运行前拆分为已发布 V3 视图（剥离 `owner`、`version` 重盖章为 3）加可选 owner。未剥离的 `owner` 对已发布 V2/V3 键集合是外来键，因此在每条解码与校验路径上拆分都是必需的。
- 事件行、信封、表面元数据与关系检查完全是已发布 V3 规则。行准入复用 `assertV3RowAdmission`；未知或已淘汰的必需事件类型由词汇感知的恢复拒绝，此处不重新审计。
- V4 写入方只为按用户 Web 登录后创建的会话盖章 `owner`。重新打开为 V4 的 V3 录音保留其解码所得头部；本包既不要求也不清除该字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

[阶段](src/migration.ts)只拥有播种切点推导，并原样发出每个事件。[编解码器](src/codec.ts)将帧格式与行解码委托给冻结 V3 编解码器，只拥有头部版本与可选 owner。[恢复器](src/validation.ts)剥离 owner、重盖章版本，通过冻结 V3 关系校验后返回原始 V4 产物。冻结 V0 到 V1、V1 到 V2、V2 到 V3 语义保持不变。不发布运行时不变量伴随，因为本库不拥有可独立观察的注册或状态副本。

[迁移测试](tests/migration.spec.ts)固定重盖章、透传、切点推导、编解码器往返、拒绝用例，以及通过每条相邻阶段的严格恢复。[持久化集成](../session-persistence-jsonl/tests/jsonl.spec.ts)拥有发布证据。[已发布格式决策](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)拥有将相邻组合与原生准入分开测试的理由。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [已发布 V2 到 V3](../session-format-v2-to-v3/README.zh.md) — 冻结的前序转换与源编解码器。
- [已发布格式迁移](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md) — 已发布世代的兼容性义务。
- [会话格式状态](../../../docs/session-format-status.zh.md) — 已发布版本与迁移支持。
- [添加会话格式版本](../../../docs/cookbook/adding-a-session-format-version.zh.md) — 本条边遵循的版本升级流程。

-----

<a id="model-experience"></a>
## 模型体验

### 历史恢复

#### 模型看到什么

每个历史请求通过 `sessionFormatV3ToV4` 事件透传保留其确切的提示词、消息内容与事件顺序。头部 `owner` 从不对模型可见。

#### Token 影响

本条边不增加、删除或改写任何模型可见文本。

#### KV 缓存影响

本条边逐字节保留历史请求含义与模型配置；不保证提供者缓存命中。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅元数据的 owner** — owner 标识创建主体，用于归属与按用户列表；它在本包内不携带任何授权决定，任何事件负载也不能引用它。
- **不做文件或设置迁移** — 本包从不改变已提交的世代或 `settings.yaml`。持久化拥有最终后继的发布；已存在的 V4 世代不重跑其进入边。参见[格式发布状态](../../../docs/session-format-status.zh.md)与[已发布格式策略](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)中的兼容性义务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
