# XBot v1.1.0 Release Notes

发布日期：2026-06-06

## 概览

`v1.1.0` 整合了 UBot v4.4.0 中适合个人私聊 Agent 场景的迭代，重点是智能个人提醒、模型配置治理、系统状态巡检、后台知识库 CRUD、记忆详情和操作日志。

## 主要更新

- 个人定时任务支持智能工作日、节假日/休息日、自定义星期、执行开始时间、执行结束时间和执行间隔。
- `#健康` 升级为系统健康检查，展示 NapCat、回复模型和记忆模型连接状态；`#服务器` 展示 Node、PID、运行时长和内存。
- 后台新增 System Health 和 Model Settings，可检测模型连接并选择回复、记忆、TTS 模型，API Key 保存后不会在 API 中明文返回。
- 后台知识库支持新增、编辑、停用和删除；记忆和候选记忆支持详情编辑与证据展开。
- 后台和 API 的用户、记忆、知识库、系统设置变更写入 `data/admin-operations.jsonl`。

## 验证

```powershell
$env:PATH='D:\environment\nvm\v22.17.0;' + $env:PATH; npm test
```

当前本地验证：13/13 tests passed。
