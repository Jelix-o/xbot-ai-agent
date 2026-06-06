# XBot v1.2.0 Parallel Deployment

Target layout:

- app directory: `/opt/xbot`
- service: `xbot.service`
- reverse WebSocket: `0.0.0.0:6299/onebot/ws`
- admin HTTP: `127.0.0.1:6300`

Do not modify `/opt/ai-project`, `ai-project.service`, or existing ports `6199/6200`.

## Deploy

```powershell
.\scripts\deploy-xbot.ps1
```

On the server, configure `/opt/xbot/.env` with:

```env
NAPCAT_MODE=reverse
NAPCAT_REVERSE_WS_HOST=0.0.0.0
NAPCAT_REVERSE_WS_PORT=6299
NAPCAT_REVERSE_WS_PATH=/onebot/ws
ADMIN_HTTP_ENABLED=true
ADMIN_HTTP_HOST=127.0.0.1
ADMIN_HTTP_PORT=6300
```

Then install and start:

```bash
sudo cp /opt/xbot/release/xbot.service /etc/systemd/system/xbot.service
sudo systemctl daemon-reload
sudo systemctl enable --now xbot.service
sudo systemctl status xbot.service --no-pager
```

NapCat must add a separate reverse WebSocket connection to `ws://host.docker.internal:6299/onebot/ws` or the equivalent host address. Keep the existing AI-Project reverse connection unchanged.

The deploy script preserves server-only `.env`, `data/`, and `config/users.json`. Use `config/users.example.json` only as a first-time template.

## v1.2.0 Notes

`v1.2.0` replaces the earlier standalone XBot admin page with a UBot-style multi-page admin console adapted for QQ private-chat users. The deployment still runs beside AI-Project and preserves the same XBot ports.
