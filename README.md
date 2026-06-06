# XBot

XBot v1.2.0 is a QQ private-chat Agent Skills bot based on `NapCat + OneBot + Node.js + TypeScript`.

It is designed for one-to-one QQ private chat:

- authorized private users can chat naturally without `@` or wake words
- each user has isolated conversation context, current skill, model mode, memories, knowledge entries, and reminders
- super admins invite, disable, and remove users
- high-confidence personal memories are approved automatically, while low-confidence candidates stay reviewable in the admin console
- V1.2.0 rebuilds the admin console from the UBot multi-page UI while adapting all management data to private-user scope
- deployment is intended to run in parallel with the old group bot on separate ports

## Commands

- `#帮助` / `#功能`: show command overview
- `#技能 列表`: list allowed skills
- `#技能 切换 <skillId>`: switch current user skill
- `#模型 状态`: show current reply model mode and configured model health
- `#模型 切换 <mode>`: switch current user reply model mode
- `#对话 清空`: clear current user conversation context
- `#记忆 状态`: show personal memory and pending candidate counts
- `#画像`: summarize current user's approved memories
- `#日记`: summarize today's private chat
- `#节假日`: show weekend and 2026 public-holiday countdowns
- `#语音 <内容>`: reply with private voice when TTS is configured
- `#定时任务 添加 每30分钟提醒我喝水`
- `#定时任务 添加 工作日 09:00-18:00 每30分钟提醒我喝水`
- `#定时任务 列表`
- `#定时任务 删除 <taskId>`
- `#定时任务 暂停 <taskId>` / `#定时任务 开启 <taskId>`
- `#用户 邀请 <QQ号>` / `#用户 禁用 <QQ号>` / `#用户 移除 <QQ号>`: super admin only
- `#状态` / `#健康` / `#服务器`: super admin only; `#健康` checks NapCat and configured models

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm run build
npm start
```

Default ports are intentionally different from AI-Project:

- private reverse WebSocket: `6299`
- admin HTTP: `6300`

Configure NapCat reverse WebSocket to:

```text
ws://127.0.0.1:6299/onebot/ws
```

## Data

- `config/users.json`: authorized users and super admins
- `skills/*.json`: Agent Skills
- `data/conversations.json`: private conversation contexts
- `data/personal-memory.json`: approved long-term personal memories
- `data/personal-memory-candidates.json`: reviewable memory candidates
- `data/personal-reminders.json`: private reminder tasks
- `data/personal-knowledge-base.json`: personal FAQ entries
- `data/system-settings.json`: model settings and selected model ids
- `data/admin-operations.jsonl`: admin operation log

## Parallel Server Deployment

Deploy XBot beside AI-Project instead of replacing it:

- application directory: `/opt/xbot`
- service name: `xbot.service`
- reverse WebSocket: `0.0.0.0:6299/onebot/ws`
- admin HTTP: `127.0.0.1:6300`

Do not overwrite AI-Project's `/opt/ai-project`, `ai-project.service`, `.env`, `data/`, or NapCat group-chat connection.

## Build And Test

```powershell
npm run build
npm test
```
