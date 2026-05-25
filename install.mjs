#!/usr/bin/env node
// peerd installer — wires Claude Code to this repo idempotently.
//
//   1. Builds peer-mcp's TypeScript so the bin scripts exist on disk.
//   2. Symlinks skills/<name>/SKILL.md into ~/.claude/skills/<name>/SKILL.md.
//   3. Adds (idempotently) to ~/.claude/settings.json:
//        - hooks.Stop entry that runs peer-check-inbox
//        - statusLine entry that runs peer-status-line
//        - mcpServers.peerd entry pointing at peer-mcp's tsx entrypoint
//   4. Optionally installs a LaunchAgent plist for peerd (--launchagent).
//   5. Prints next steps.
//
// Safe to re-run.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.dirname(__filename);
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");
const SKILLS_DIR = path.join(CLAUDE_DIR, "skills");
const PEERD_STATE = path.join(CLAUDE_DIR, "peerd");

const WANT_LAUNCH_AGENT = process.argv.includes("--launchagent");
const VERBOSE = process.argv.includes("--verbose");

const log = (...a) => console.log("[install]", ...a);
const v = (...a) => { if (VERBOSE) console.log("[install]", ...a); };

function readJsonSafe(p) {
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) {
    console.error(`[install] failed to parse ${p}: ${e.message}`);
    console.error(`[install] back it up and re-run, or fix manually.`);
    process.exit(2);
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function step1_build() {
  log("step 1/5: building peer-mcp (so bin scripts exist)");
  const r = spawnSync("npm", ["run", "build", "-w", "peer-mcp"], {
    cwd: REPO_ROOT,
    stdio: VERBOSE ? "inherit" : "pipe",
  });
  if (r.status !== 0) {
    console.error("[install] npm run build failed.");
    if (!VERBOSE) console.error(r.stdout?.toString(), r.stderr?.toString());
    process.exit(r.status ?? 1);
  }
}

function step2_skills() {
  log("step 2/5: installing skills to ~/.claude/skills/");
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const srcSkills = path.join(REPO_ROOT, "skills");
  for (const name of fs.readdirSync(srcSkills)) {
    const src = path.join(srcSkills, name);
    const dst = path.join(SKILLS_DIR, name);
    if (!fs.statSync(src).isDirectory()) continue;

    if (fs.existsSync(dst)) {
      const stat = fs.lstatSync(dst);
      if (stat.isSymbolicLink() && fs.readlinkSync(dst) === src) {
        v(`  ✓ ${name}: already symlinked to repo`);
        continue;
      }
      console.error(`  ! ${name}: ~/.claude/skills/${name} exists and is not a symlink to this repo`);
      console.error(`    leaving it alone; remove it manually if you want this repo's version.`);
      continue;
    }
    fs.symlinkSync(src, dst, "dir");
    log(`  + ${name}: symlinked ~/.claude/skills/${name} -> ${src}`);
  }
}

function step3_settings() {
  log("step 3/5: wiring settings.json (Stop hook, status line, MCP server)");
  const settings = readJsonSafe(SETTINGS_PATH);

  const peerMcpEntry = path.join(REPO_ROOT, "peer-mcp", "dist", "index.js");
  const checkInboxEntry = path.join(REPO_ROOT, "peer-mcp", "dist", "check_inbox.js");
  const statusLineEntry = path.join(REPO_ROOT, "peer-mcp", "dist", "status_line.js");

  for (const p of [peerMcpEntry, checkInboxEntry, statusLineEntry]) {
    if (!fs.existsSync(p)) {
      console.error(`[install] missing built file: ${p}`);
      console.error(`[install] step 1 should have produced this. Inspect npm run build output.`);
      process.exit(2);
    }
  }

  // --- Stop hook ---
  settings.hooks = settings.hooks ?? {};
  settings.hooks.Stop = settings.hooks.Stop ?? [];
  const stopCmd = `node ${JSON.stringify(checkInboxEntry)}`;
  // Claude Code's hook schema: each entry is { matcher, hooks: [{type, command, ...}] }.
  const stopExists = settings.hooks.Stop.some(
    (h) => Array.isArray(h?.hooks) && h.hooks.some((c) => c?.command === stopCmd),
  );
  if (!stopExists) {
    settings.hooks.Stop.push({
      matcher: "",
      hooks: [
        { type: "command", command: stopCmd, timeout: 5 },
      ],
    });
    log("  + Stop hook -> peer-check-inbox");
  } else {
    v("  ✓ Stop hook already present");
  }

  // --- Status line ---
  const statusCmd = `node ${JSON.stringify(statusLineEntry)}`;
  if (!settings.statusLine || settings.statusLine.command !== statusCmd) {
    if (settings.statusLine) {
      log(`  ! existing statusLine command "${settings.statusLine.command}" — overwriting with peerd status line`);
      log(`    (back up settings.json first if you want to preserve your previous one)`);
    }
    settings.statusLine = {
      type: "command",
      command: statusCmd,
      padding: 1,
      refreshInterval: 5,
    };
    log("  + statusLine -> peer-status-line");
  } else {
    v("  ✓ statusLine already configured");
  }

  // --- MCP server ---
  settings.mcpServers = settings.mcpServers ?? {};
  const desired = {
    command: "node",
    args: [peerMcpEntry],
    env: {},
  };
  const cur = settings.mcpServers.peerd;
  if (
    !cur ||
    cur.command !== desired.command ||
    JSON.stringify(cur.args) !== JSON.stringify(desired.args)
  ) {
    settings.mcpServers.peerd = desired;
    log("  + mcpServers.peerd -> peer-mcp");
  } else {
    v("  ✓ mcpServers.peerd already configured");
  }

  writeJson(SETTINGS_PATH, settings);
  log(`  → wrote ${SETTINGS_PATH}`);
}

function step4_state() {
  log("step 4/5: ensuring ~/.claude/peerd/ exists");
  fs.mkdirSync(PEERD_STATE, { recursive: true });
  fs.mkdirSync(path.join(PEERD_STATE, "tls"), { recursive: true });
  fs.mkdirSync(path.join(PEERD_STATE, "calls"), { recursive: true });
  fs.mkdirSync(path.join(PEERD_STATE, "inbox"), { recursive: true });
  fs.mkdirSync(path.join(PEERD_STATE, "voicemail"), { recursive: true });
  const peersToml = path.join(PEERD_STATE, "peers.toml");
  if (!fs.existsSync(peersToml)) {
    const username = os.userInfo().username;
    const stub = `# peerd config — edit and add peer entries below.\nself = "${username}"\nport = 7777\n\n# Example peer entry:\n# [peers.alice]\n# host          = "alice-mac.tailnet-name.ts.net"\n# port          = 7777\n# token         = "sk_peer_OUTGOING"   # bearer WE present to alice\n# inbound_token = "sk_peer_INCOMING"   # bearer we EXPECT from alice\n# fingerprint   = "sha256/..."         # alice's TLS cert fingerprint\n`;
    fs.writeFileSync(peersToml, stub);
    log(`  + wrote stub ${peersToml}`);
  } else {
    v("  ✓ peers.toml already present");
  }
}

function step5_launch_agent() {
  if (!WANT_LAUNCH_AGENT) {
    log("step 5/5: skipping LaunchAgent (re-run with --launchagent to install)");
    return;
  }
  if (process.platform !== "darwin") {
    log("step 5/5: --launchagent ignored on non-mac");
    return;
  }
  log("step 5/5: installing LaunchAgent so peerd starts at login");

  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.peerd.daemon.plist");
  const nodeBin = process.execPath;
  const peerdEntry = path.join(REPO_ROOT, "peerd", "dist", "index.js");

  if (!fs.existsSync(peerdEntry)) {
    log("  building peerd first…");
    const r = spawnSync("npm", ["run", "build", "-w", "peerd"], {
      cwd: REPO_ROOT,
      stdio: VERBOSE ? "inherit" : "pipe",
    });
    if (r.status !== 0) {
      console.error("[install] peerd build failed; not installing LaunchAgent");
      return;
    }
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.peerd.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${peerdEntry}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(PEERD_STATE, "peerd.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(PEERD_STATE, "peerd.err.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  log(`  + wrote ${plistPath}`);

  spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["load", plistPath], { stdio: "pipe" });
  if (r.status === 0) {
    log("  ✓ peerd LaunchAgent loaded (will start now and at every login)");
  } else {
    log("  ! launchctl load failed; you can manually run:");
    log(`    launchctl load ${plistPath}`);
  }
}

function printNextSteps() {
  log("");
  log("──────────────────────────────────────────────────────");
  log("✅ install complete");
  log("──────────────────────────────────────────────────────");
  log("");
  log("Next steps:");
  log("  1. Edit ~/.claude/peerd/peers.toml to add your teammate(s).");
  log("     You'll need their host, two tokens, and their TLS fingerprint.");
  if (!WANT_LAUNCH_AGENT) {
    log("");
    log("  2. Start peerd in a terminal (or re-run install with --launchagent):");
    log(`     cd ${JSON.stringify(REPO_ROOT)} && npm run peerd`);
  } else {
    log("");
    log("  2. peerd is running as a LaunchAgent. Check status:");
    log("     launchctl list | grep com.peerd");
    log(`     tail -f ${path.join(PEERD_STATE, "peerd.log")}`);
  }
  log("");
  log("  3. Restart Claude Code so it picks up the new MCP server, Stop hook,");
  log("     and status line. Then in any session, try:");
  log("       /call <peer-name> <topic>");
  log("");
  log("  4. peerd's TLS fingerprint (share with teammates so they can pin you):");
  const certPath = path.join(PEERD_STATE, "tls", "cert.pem");
  if (fs.existsSync(certPath)) {
    const out = spawnSync("openssl", ["x509", "-noout", "-fingerprint", "-sha256", "-in", certPath], { encoding: "utf8" });
    if (out.status === 0) {
      const m = /Fingerprint=([A-F0-9:]+)/.exec(out.stdout);
      if (m) log(`     sha256/${m[1].replace(/:/g, "").toLowerCase()}`);
      else log("     (couldn't parse; check ~/.claude/peerd/tls/cert.pem manually)");
    }
  } else {
    log("     (will be printed when peerd first starts and generates its cert)");
  }
}

function main() {
  log(`repo:   ${REPO_ROOT}`);
  log(`claude: ${CLAUDE_DIR}`);
  step1_build();
  step2_skills();
  step3_settings();
  step4_state();
  step5_launch_agent();
  printNextSteps();
}

main();
