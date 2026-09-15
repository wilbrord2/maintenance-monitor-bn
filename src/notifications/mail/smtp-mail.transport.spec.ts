import nodemailer from 'nodemailer';
import { SmtpMailTransport } from './smtp-mail.transport';
import { openSmtpSocket } from './smtp-socket';

jest.mock('nodemailer', () => ({ __esModule: true, default: { createTransport: jest.fn() } }));
jest.mock('./smtp-socket', () => ({ openSmtpSocket: jest.fn() }));

const createTransport = nodemailer.createTransport as unknown as jest.Mock;
const openSocket = openSmtpSocket as jest.Mock;

type GetSocket = (options: unknown, callback: (err: Error | null, socketOptions: unknown) => void) => void;

const settings = {
  host: 'smtp.company.test',
  port: 587,
  secure: false,
  username: 'mailer',
  password: 'smtp-secret',
  from: 'maintenance@company.test',
  fromName: 'Maintenance Monitor',
};

describe('SmtpMailTransport', () => {
  const transporter = {
    sendMail: jest.fn().mockResolvedValue({}),
    verify: jest.fn().mockResolvedValue(true),
    close: jest.fn(),
  };

  beforeEach(() => {
    createTransport.mockReset().mockReturnValue(transporter);
    openSocket.mockReset();
  });

  const getSocketOption = (): GetSocket =>
    (createTransport.mock.calls[0]![0] as { getSocket: GetSocket }).getSocket;

  it('configures a pooled, TLS-enforcing transport from environment settings', () => {
    new SmtpMailTransport(settings);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: true,
        host: 'smtp.company.test',
        port: 587,
        secure: false,
        auth: { user: 'mailer', pass: 'smtp-secret' },
        tls: { minVersion: 'TLSv1.2' },
        getSocket: expect.any(Function),
      }),
    );
  });

  it('omits authentication when no credentials are configured', () => {
    new SmtpMailTransport({ ...settings, username: undefined, password: undefined });
    expect(createTransport.mock.calls[0]![0]).not.toHaveProperty('auth');
  });

  it('hands nodemailer a socket opened with IPv6/IPv4 racing', async () => {
    const socket = { fake: 'socket' };
    openSocket.mockResolvedValue(socket);
    new SmtpMailTransport(settings);

    const result = await new Promise<{ err: Error | null; socketOptions: unknown }>((resolve) => {
      getSocketOption()({}, (err, socketOptions) => resolve({ err, socketOptions }));
    });
    expect(openSocket).toHaveBeenCalledWith('smtp.company.test', 587, 10_000);
    expect(result).toEqual({ err: null, socketOptions: { connection: socket } });
  });

  it('reports socket connection failures to nodemailer', async () => {
    const failure = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    openSocket.mockRejectedValue(failure);
    new SmtpMailTransport(settings);

    const err = await new Promise<Error | null>((resolve) => {
      getSocketOption()({}, (error) => resolve(error));
    });
    expect(err).toBe(failure);
  });

  it('sends from the configured company address and delegates verify/close', async () => {
    const transport = new SmtpMailTransport(settings);
    await transport.send({ to: 'tech@company.test', subject: 'S', text: 'T', html: '<p>H</p>' });
    expect(transporter.sendMail).toHaveBeenCalledWith({
      from: { name: 'Maintenance Monitor', address: 'maintenance@company.test' },
      to: 'tech@company.test',
      subject: 'S',
      text: 'T',
      html: '<p>H</p>',
    });
    await transport.verify();
    transport.close();
    expect(transporter.verify).toHaveBeenCalled();
    expect(transporter.close).toHaveBeenCalled();
  });
});
