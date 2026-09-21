# Remote access through Cloudflare Tunnel

Goal:

- `https://panel.gory-staff.ru` opens this control panel from anywhere.
- The same panel can start, stop, and restart allowed local projects.
- Web analytics events can be sent to `/api/collect` through the public panel hostname.

Important:

- Do not expose this panel before changing `.env`.
- Do not use the default `admin123` password.
- Keep `PANEL_HOST=127.0.0.1`; Cloudflare Tunnel will connect to it locally.

## 1. Create `.env`

Create `D:\prodect\ControlPanel\.env`:

```env
PANEL_HOST=127.0.0.1
PANEL_PORT=8787
PANEL_EMAIL=your@email.com
PANEL_PASSWORD=long-strong-password
PANEL_TOKEN_SECRET=long-random-secret-at-least-32-chars
```

Restart the panel after changing this file.

## 2. Cloudflare Tunnel

Official Cloudflare docs say Tunnel publishes a local service to a public hostname without opening inbound ports.

Use the Cloudflare dashboard path:

1. Cloudflare dashboard -> Networking -> Tunnels.
2. Create a tunnel.
3. Choose Windows and run the install command shown by Cloudflare on this PC.
4. Add a published application route:
   - Hostname: `panel.gory-staff.ru`
   - Service URL: `http://127.0.0.1:8787`

Cloudflare docs:

- https://developers.cloudflare.com/tunnel/
- https://developers.cloudflare.com/tunnel/setup/
- https://developers.cloudflare.com/tunnel/advanced/local-management/as-a-service/windows/

## 3. Tracking code for websites

After the panel is available as `https://panel.gory-staff.ru`, use this format on a project website:

```html
<script async src="https://panel.gory-staff.ru/tracker.js" data-project="PROJECT_ID"></script>
```

Example for Messenger/Onda:

```html
<script async src="https://panel.gory-staff.ru/tracker.js" data-project="tg"></script>
```

The project id is visible in `D:\prodect\ControlPanel\data\projects.json`.

## 4. What becomes available remotely

- Login to the panel from anywhere.
- View project analytics.
- View web metrics.
- Start/stop/restart only allow-listed projects.
- Open project URLs.
- See logs and action history.

## 5. Security checklist before using public access

- Change `.env` password and token secret.
- Do not share the panel URL/password.
- Keep only needed projects startable.
- Avoid enabling random `.bat` files.
- Prefer Docker/npm commands over arbitrary scripts.
- Add Cloudflare Access/Zero Trust in front of `panel.gory-staff.ru` if more security is needed.
