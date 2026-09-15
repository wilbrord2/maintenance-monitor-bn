import { createServer, type Server, type Socket } from 'node:net';
import { type AddressInfo } from 'node:net';
import { openSmtpSocket } from './smtp-socket';

function listen(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.end('220 test ESMTP\r\n'));
    server.listen(0, host, () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe('openSmtpSocket', () => {
  const sockets: Socket[] = [];

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
  });

  it('connects over IPv4 even when the hostname also resolves to an unusable IPv6 address', async () => {
    // "localhost" resolves to ::1 and 127.0.0.1; the server listens only on IPv4,
    // mirroring an SMTP host whose IPv6 address cannot be reached.
    const { server, port } = await listen('127.0.0.1');
    try {
      const started = Date.now();
      const socket = await openSmtpSocket('localhost', port, 5000);
      sockets.push(socket);
      expect(socket.remoteAddress).toMatch(/127\.0\.0\.1$/);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await close(server);
    }
  });

  it('rejects when nothing is listening', async () => {
    const { server, port } = await listen('127.0.0.1');
    await close(server);
    await expect(openSmtpSocket('127.0.0.1', port, 5000)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('gives up after the timeout', async () => {
    // A non-routable address either never answers (timeout) or is rejected by the local network stack.
    const error = await openSmtpSocket('10.255.255.1', 25, 200).catch((e: unknown) => e as { code?: string });
    expect(['ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']).toContain((error as { code?: string }).code);
  });
});
