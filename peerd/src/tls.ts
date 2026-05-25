import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import selfsigned from "selfsigned";

export interface TlsMaterial {
  certPem: string;
  keyPem: string;
  fingerprintSha256: string; // "sha256/<hex>"
}

export async function ensureTls(stateDir: string, advertisedName: string): Promise<TlsMaterial> {
  const tlsDir = path.join(stateDir, "tls");
  await fs.promises.mkdir(tlsDir, { recursive: true });
  const certPath = path.join(tlsDir, "cert.pem");
  const keyPath = path.join(tlsDir, "key.pem");

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    const attrs = [{ name: "commonName", value: advertisedName }];
    const notBeforeDate = new Date();
    const notAfterDate = new Date(notBeforeDate.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);
    const pems = await selfsigned.generate(attrs, {
      keySize: 2048,
      notBeforeDate,
      notAfterDate,
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "subjectAltName", altNames: [
          { type: 2, value: advertisedName },
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
        ]},
      ],
    });
    await fs.promises.writeFile(certPath, pems.cert, { mode: 0o600 });
    await fs.promises.writeFile(keyPath, pems.private, { mode: 0o600 });
  }

  const certPem = await fs.promises.readFile(certPath, "utf8");
  const keyPem = await fs.promises.readFile(keyPath, "utf8");
  const fingerprintSha256 = fingerprintOfPem(certPem);
  return { certPem, keyPem, fingerprintSha256 };
}

export function fingerprintOfPem(pem: string): string {
  const cert = new crypto.X509Certificate(pem);
  const der = cert.raw;
  const hash = crypto.createHash("sha256").update(der).digest("hex");
  return `sha256/${hash}`;
}
