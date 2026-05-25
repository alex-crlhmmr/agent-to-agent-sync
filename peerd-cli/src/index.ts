#!/usr/bin/env node
// peerd — setup and pairing CLI for the agent-to-agent sync system.

import { cmdInit } from "./cmd/init.js";
import { cmdPair } from "./cmd/pair.js";
import { cmdList } from "./cmd/list.js";
import { cmdStatus } from "./cmd/status.js";
import { cmdRemove } from "./cmd/remove.js";
import { cmdReady } from "./cmd/ready.js";

const HELP = `peerd — agent-to-agent sync CLI

Usage:
  peerd init [--name <name>] [--no-launchagent] [--no-alias]
      Configure this machine: write Claude Code settings, generate TLS cert,
      start the daemon (as LaunchAgent unless --no-launchagent), and add a
      shell alias so 'claude' loads the peerd channel by default.

  peerd ready [--seconds <N>]
      Put this peerd into pairing-receive mode for N seconds (default 60).
      A teammate can now run 'peerd pair <your-hostname>' on theirs.

  peerd pair <hostname> [--seconds <N>]
      Pair with the peerd at <hostname> (Tailscale MagicDNS or IP). The remote
      side must be in 'peerd ready' mode. Tokens and TLS fingerprints are
      auto-exchanged; both sides' peers.toml is updated.

  peerd list
      Show known peers + their online state.

  peerd status
      Show daemon health, TLS fingerprint, active calls.

  peerd remove <peer-name>
      Drop a peer from peers.toml.

  peerd help
      Print this message.

Environment:
  PEERD_STATE_DIR     defaults to ~/.claude/peerd
`;

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    switch (cmd) {
      case "init":    return await cmdInit(rest);
      case "ready":   return await cmdReady(rest);
      case "pair":    return await cmdPair(rest);
      case "list":    return await cmdList(rest);
      case "status":  return await cmdStatus(rest);
      case "remove":  return await cmdRemove(rest);
      default:
        console.error(`peerd: unknown command "${cmd}". Try 'peerd help'.`);
        return 2;
    }
  } catch (err: any) {
    console.error(`peerd: ${err?.message ?? err}`);
    if (process.env.PEERD_CLI_TRACE) console.error(err?.stack);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
