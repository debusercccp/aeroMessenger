# Aero Messenger

A desktop WhatsApp client with a **Frutiger Aero** look — glossy glass panels,
aqua/lime gradients, floating bubbles, gloss-highlighted buttons.

## Stack & why

| Layer | Choice | Reason |
|-------|--------|--------|
| App shell | **Electron** | Cross-platform desktop window; UI is HTML/CSS, perfect for the glossy Aero aesthetic |
| WhatsApp link | **whatsapp-web.js** | Most mature library; drives a real WhatsApp Web session and links via QR like the phone app |
| Language | **JavaScript / Node.js** | whatsapp-web.js is Node-only, so it unifies backend + UI in one language |
| QR rendering | **qrcode** | Turns the WhatsApp pairing string into an in-app QR image |

## Run

```bash
npm install      # already done — pulls Electron + Chromium (~a minute)
npm start
```

1. The window opens on a glossy aqua background and shows a **QR code**.
2. On your phone: **WhatsApp → Linked devices → Link a device → scan**.
3. Once linked, chats appear in the sidebar. Click one to read/send messages.

The session is saved locally (`LocalAuth`), so you only scan once. Use **Logout**
to unlink.

## Features

- **Text-only chats** — photos, audio, video and other media are filtered out;
  the chat-list preview shows a small label (e.g. `📷 Photo`) instead.
- **Refresh** — the **↻** button reloads the chat list and the open conversation;
  the list also **auto-refreshes every 30 s** while connected.
- **Edit / delete messages** — hover a bubble for inline edit (your own messages,
  within WhatsApp's ~15 min window) and delete (for everyone on your messages,
  for-you on others').
- **Message turnover** — the conversation keeps at most a rolling window of
  recent messages in memory, and Chromium's on-disk caches are capped, so the
  app can't balloon to gigabytes over time.

## Install (global launcher)

```bash
./install.sh
```

Adds a `aero-messenger` command to `~/.local/bin` and a desktop entry to
`~/.local/share/applications`, so it shows up in your application launcher with
an icon. Re-runnable; safe to repeat.

### Wayland / X11

`npm start` runs `launch.js`, which auto-detects the session: on Wayland
(niri, sway, GNOME-Wayland — anything with `WAYLAND_DISPLAY` set) it forces
Electron's native Wayland backend, because a stale/unauthorized `DISPLAY`
Xwayland stub otherwise makes Electron crash with *"Missing X server"*. On a
real X11 session it uses Electron's normal default.

If you ever need to force the plain X11 launch: `npm run start:x11`.

## Project layout

```
launch.js            Supervisor: picks Wayland/X11 backend, cleans up Chromium on exit
main.js              Electron main process + whatsapp-web.js client + IPC
preload.js           Secure bridge (contextIsolation) exposing window.wa.*
renderer/index.html  UI structure (login/QR view + messenger view)
renderer/styles.css  Frutiger Aero theme
renderer/renderer.js UI logic (chat list, conversation, edit/delete, live updates)
assets/icon.svg      App icon (Frutiger Aero orb)
install.sh           Installs the global launcher + desktop entry
```

## Notes / caveats

- **Unofficial integration.** WhatsApp has no open personal API; this automates
  WhatsApp Web. It works well for personal use but isn't endorsed by WhatsApp —
  avoid heavy/bulk automation.
- Requires the phone to be online for WhatsApp Web sessions to sync.
- First launch downloads/launches a bundled Chromium via Puppeteer.
