#!/usr/bin/env -S npx tsx
// peer-notify — fire a macOS notification. No-op on non-mac.
//
// Usage:  peer-notify --title "..." --message "..." [--sound Glass] [--subtitle "..."]

import { spawn } from "node:child_process";

interface Args {
  title: string;
  message: string;
  subtitle?: string;
  sound?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { sound: "Glass" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--title") out.title = argv[++i];
    else if (a === "--message") out.message = argv[++i];
    else if (a === "--subtitle") out.subtitle = argv[++i];
    else if (a === "--sound") out.sound = argv[++i];
  }
  if (!out.title || !out.message) {
    console.error("usage: peer-notify --title <t> --message <m> [--subtitle <s>] [--sound <n>]");
    process.exit(2);
  }
  return out as Args;
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function main() {
  if (process.platform !== "darwin") {
    process.exit(0);
  }
  const args = parseArgs(process.argv.slice(2));
  const parts: string[] = [
    `display notification "${escape(args.message)}"`,
    `with title "${escape(args.title)}"`,
  ];
  if (args.subtitle) parts.push(`subtitle "${escape(args.subtitle)}"`);
  if (args.sound) parts.push(`sound name "${escape(args.sound)}"`);
  const script = parts.join(" ");
  const child = spawn("osascript", ["-e", script], { stdio: "ignore" });
  child.on("error", () => process.exit(0));
  child.on("exit", (code) => process.exit(code ?? 0));
}

main();
