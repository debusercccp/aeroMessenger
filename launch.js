#!/usr/bin/env node
'use strict';

/*
 * Portable launcher for Aero Messenger.
 *
 * Electron must receive the Ozone backend flag as a real command-line
 * argument before Chromium starts; setting it from inside main.js is too
 * late. On a Wayland session (niri / sway / GNOME-Wayland, etc.) DISPLAY
 * often points at an unauthorized Xwayland stub, so Electron's default and
 * even its `--ozone-platform-hint=auto` wrongly pick X11 and crash with
 * "Missing X server". We detect a real Wayland socket and force the native
 * Wayland backend; otherwise we let Electron use its normal (X11) default.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const electron = require('electron'); // resolves to the electron binary path

// The WhatsApp engine (whatsapp-web.js) runs its own headless Chromium via
// Puppeteer. Electron tends to swallow termination signals natively and exit
// before its JS cleanup runs, which leaves that Chromium orphaned and running.
// As the supervising parent, we reliably catch exit and sweep any leftover
// engine Chromium, identified by our private session path in its arguments.
const ENGINE_TAG = 'aero-messenger/wa-session';

function sweepEngineChromium() {
  let killed = 0;
  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch (_) { return 0; } // non-Linux
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    let cmd = '';
    try { cmd = fs.readFileSync('/proc/' + ent + '/cmdline', 'utf8').replace(/\0/g, ' '); }
    catch (_) { continue; }
    if (cmd.includes(ENGINE_TAG) && cmd.includes('chrome')) {
      try { process.kill(Number(ent), 'SIGKILL'); killed++; } catch (_) { /* gone */ }
    }
  }
  return killed;
}

const args = ['.'];

if (process.env.WAYLAND_DISPLAY) {
  args.push('--ozone-platform=wayland', '--enable-features=UseOzonePlatform,WaylandWindowDecorations');
}

// Pass through any extra args the user supplied (e.g. --no-sandbox).
args.push(...process.argv.slice(2));

const child = spawn(electron, args, { stdio: 'inherit' });

let terminating = false;
let exitCode = 0;

// Final teardown: by the time Electron has exited, its headless Chromium is
// orphaned but still alive, so this is the reliable moment to sweep it.
function finish() {
  sweepEngineChromium();
  process.exit(exitCode);
}

// On a termination signal, forward it so Electron can quit, then let the
// child's 'close' handler do the sweep. A timeout guards against a child that
// refuses to exit.
function terminate() {
  if (terminating) return;
  terminating = true;
  try { child.kill('SIGTERM'); } catch (_) {}
  setTimeout(finish, 4000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, terminate);
}

child.on('close', (code, signal) => {
  exitCode = signal ? 0 : (code || 0);
  finish();
});
child.on('error', (err) => {
  console.error('Failed to launch Electron:', err.message);
  process.exit(1);
});
