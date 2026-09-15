import { connect, type Socket } from 'node:net';

/** How long each address family attempt may take before the next address is tried in parallel. */
const FAMILY_ATTEMPT_TIMEOUT_MS = 250;

/**
 * Opens a TCP connection to an SMTP server using Node's "Happy Eyeballs"
 * (RFC 8305) address selection: IPv6 and IPv4 addresses are tried in a
 * staggered race and the first to connect wins.
 *
 * Nodemailer on its own picks a random resolved address and only falls back
 * after its connection timeout, so on networks where IPv6 is advertised but
 * not routable (common with home and office routers) roughly half of all
 * connections to hosts such as smtp.gmail.com stall for many seconds.
 *
 * The returned socket is plain TCP; nodemailer performs the TLS handshake
 * (implicit TLS or STARTTLS) and certificate verification on top of it.
 */
export function openSmtpSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host,
      port,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: FAMILY_ATTEMPT_TIMEOUT_MS,
    });

    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(
        Object.assign(new Error(`Connection to ${host}:${port} timed out after ${timeoutMs}ms`), {
          code: 'ETIMEDOUT',
        }),
      );
    }, timeoutMs);
    timer.unref();

    socket.once('error', fail);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', fail);
      // Guard the gap before nodemailer attaches its own handlers; it still receives every error.
      socket.on('error', () => undefined);
      resolve(socket);
    });
  });
}
