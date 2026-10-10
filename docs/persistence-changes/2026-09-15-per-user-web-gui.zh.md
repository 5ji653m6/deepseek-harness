---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-15-per-user-web-gui

[English](2026-09-15-per-user-web-gui.md) | 中文

## 概述

为 Session 头部增加可选的按用户属主（SessionHeader.owner、JsonlHeaderLine.owner），作为 Session 格式 V4 唯一的结构新增，为按用户 Web 登录后创建的会话盖章。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-15-per-user-web-gui
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-11-initial"
    after: "5d00d6b461063f2c2bd6633d2d1765f100fe1a4a9651f53d2b4d5e3203c3af76"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-09-11-initial"
    after: "cd9d35eaa760a75ee113b8bafe9ad0ff0bee068162e0050265cb1a227e9c2bf4"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

owner 通过相邻的 V3 到 V4 迁移边引入：SESSION_FORMAT_VERSION 升至 4，事件与继承切点原样通过，已提交的 v3 世代从不改写。现有 v3 记录仍然有效；目录将其恢复为无 owner 的 v4。无属主运行（进程令牌路径）不写入 owner 键，单操作员部署产生的日志与 v3 仅差头部版本。原生 v4 校验在委托给冻结的已发布 v3 规则前剥离 owner，已发布边语义保持冻结。

**发布基线例外。** 格式版本手册要求使用共享的 `release/*` 集成分支承载 writer、编解码器、目录接线与身份迁移，每项结构变换作为该基线的子项落地。本 fork 没有 `release/*` 线，因此 V4 边作为一个变更直接落在其功能分支上。该基线旨在强制履行的义务依然成立：writer、编解码器、目录接线、相邻迁移及其验证同时交付，且任何已发布世代都不被改写。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/migration.spec.ts：22 个测试通过，逐文件 100% 覆盖，固定头部重盖章、事件透传、播种切点推导、有无 owner 的编解码器往返、拒绝用例，以及通过每条相邻阶段的严格恢复。无密钥快照刷新在整个语料库发布 v4 后继，fs-read 保留声明的 v3 相邻迁移覆盖钉住。

<a id="dev-note"></a>
## 开发备注

无。
