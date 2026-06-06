# XBot v1.1.0 Commands

All commands are handled in QQ private chat.

## Normal User

- `#帮助`, `#功能`, `#命令`: show help.
- `#技能 列表`: list skills allowed for the current user.
- `#技能 切换 <skillId>`: switch the current user's skill and clear their context.
- `#模型 状态`: show the current user's reply model mode and configured model health.
- `#模型 切换 <mode>`: switch reply model mode.
- `#语音 <内容>`: generate an AI reply and send it as voice when TTS is configured.
- `#对话 清空`: clear the current user's conversation context.
- `#记忆 状态`: show approved and pending personal memories.
- `#画像`: summarize approved personal memories.
- `#日记`, `#日报`, `#摘要`: summarize today's private chat turns.
- `#节假日`, `#假期`: show weekend and 2026 public-holiday countdowns.
- `#定时任务 添加 <规则>`: add a private reminder.
  - interval example: `#定时任务 添加 每30分钟提醒我喝水`
  - smart workday window example: `#定时任务 添加 工作日 09:00-18:00 每30分钟提醒我喝水`
  - custom weekday example: `#定时任务 添加 周一三五 09:00-09:00 每1小时提醒我复盘`
- `#定时任务 列表`: list private reminders.
- `#定时任务 删除 <taskId>`: delete a private reminder.
- `#定时任务 暂停 <taskId>` / `#定时任务 开启 <taskId>`: pause or resume a private reminder.

## Super Admin

- `#用户 邀请 <QQ号>`: authorize a private-chat user.
- `#用户 禁用 <QQ号>`: disable a user without deleting their data.
- `#用户 启用 <QQ号>`: enable a disabled user.
- `#用户 移除 <QQ号>`: remove a user from the authorization list.
- `#用户 列表`: list users.
- `#状态`: show bot runtime status.
- `#健康`: show NapCat and configured model health.
- `#服务器`: show process, host, uptime, and memory status.

## Admin Console

- System Health: NapCat, model connection, Node runtime, memory usage.
- Model Settings: view and select reply, memory, and TTS models without exposing stored API keys.
- Knowledge: create, edit, disable, and delete personal FAQ entries.
- Memories: edit approved memories and inspect evidence for candidates or approved memories.
- Logs: view recent admin and console operations.

## Natural Chat

Any non-command private message from an authorized user is sent to the user's current Agent Skill. The bot stores recent context by QQ user id and may extract personal memory candidates from conversation.
