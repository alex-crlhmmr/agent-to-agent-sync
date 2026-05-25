// `peerd ready [--seconds N]` — put local peerd into pair-receive mode for N seconds.

import { ControlClient } from "../lib/peerd.js";

export async function cmdReady(args: string[]): Promise<number> {
  let seconds = 60;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--seconds") {
      seconds = Number(args[++i]);
      if (!Number.isFinite(seconds) || seconds < 5) {
        throw new Error("--seconds must be a number >= 5");
      }
    }
  }
  const client = await ControlClient.connect().catch(() => {
    throw new Error("can't reach peerd. Is it running? Try `npm run peerd`.");
  });
  try {
    const res = await client.call<{ ok: boolean; expires_at: string }>("enter_pairing_mode", { seconds }, { timeoutMs: 5000 });
    console.log(`peerd: ready to pair for ${seconds}s (until ${res.expires_at}).`);
    console.log(`Tell your teammate to run on their machine:`);
    console.log(`  peerd pair <your-tailscale-hostname>`);
    return 0;
  } finally {
    client.close();
  }
}
