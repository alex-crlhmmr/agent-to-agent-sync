import { EventEmitter } from "node:events";
import * as https from "node:https";
import { WebSocketServer } from "ws";
import { Connection } from "./connection.js";
import type { Config } from "./config.js";
import type { TlsMaterial } from "./tls.js";

const SUBPROTOCOL = "peerd.v1";

export interface PeerServerOptions {
  config: Config;
  tls: TlsMaterial;
}

export class PeerServer extends EventEmitter {
  private httpsServer?: https.Server;
  private wss?: WebSocketServer;
  private config: Config;
  private tls: TlsMaterial;

  constructor(opts: PeerServerOptions) {
    super();
    this.config = opts.config;
    this.tls = opts.tls;
  }

  async start(): Promise<void> {
    this.httpsServer = https.createServer({
      cert: this.tls.certPem,
      key: this.tls.keyPem,
    });

    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols: Set<string>) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
      maxPayload: 1 * 1024 * 1024,
    });

    this.httpsServer.on("upgrade", (req, socket, head) => {
      const headers = req.headers;
      const version = String(headers["x-peerd-version"] ?? "");
      const fromName = String(headers["x-peerd-from"] ?? "");
      const token = String(headers["x-peerd-token"] ?? "");

      if (version !== "1") {
        socket.write("HTTP/1.1 426 Upgrade Required\r\nWWW-Authenticate: Peerd error=\"UNSUPPORTED_VERSION\"\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!fromName || !token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Peerd error=\"AUTH_FAILED\"\r\n\r\n");
        socket.destroy();
        return;
      }

      const peer = this.config.peers[fromName];
      const expectedToken = peer?.inboundToken ?? peer?.token;
      if (!peer || !expectedToken || token !== expectedToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Peerd error=\"AUTH_FAILED\"\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        const conn = new Connection({
          ws,
          role: "server",
          selfName: this.config.self,
          expectedPeerName: fromName,
        });
        this.emit("connection", conn);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpsServer!.once("error", reject);
      this.httpsServer!.listen(this.config.port, () => {
        this.httpsServer!.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.wss?.close();
    await new Promise<void>((resolve) => this.httpsServer?.close(() => resolve()));
  }
}
