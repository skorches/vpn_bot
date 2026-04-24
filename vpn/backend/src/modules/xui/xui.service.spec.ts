import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { XuiService } from './xui.service';
import { XuiInbound } from './xui.types';

type MockHttp = {
  post: jest.Mock;
  request: jest.Mock;
};

const defaultInbound: XuiInbound = {
  id: 2,
  remark: 'sasha',
  up: 0,
  down: 0,
  total: 0,
  enable: true,
  port: 31872,
  protocol: 'vless',
  settings: JSON.stringify({
    clients: [{ id: 'seed-id', email: 'seed@example.com', flow: 'xtls-rprx-vision' }],
    encryption: 'mlkem768x25519plus.native.0rtt.test',
  }),
  streamSettings: JSON.stringify({
    network: 'tcp',
    security: 'reality',
    realitySettings: {
      target: 'www.amd.com:443',
      serverNames: ['www.amd.com'],
      shortIds: ['f313154afbd631d4'],
      settings: {
        fingerprint: 'chrome',
        publicKey: 'public-key',
        spiderX: '/',
      },
    },
  }),
  sniffing: JSON.stringify({
    enabled: false,
    destOverride: ['http', 'tls', 'quic', 'fakedns'],
    metadataOnly: false,
    routeOnly: false,
  }),
};

function makeConfigService(): Pick<ConfigService, 'get'> {
  const env: Record<string, string> = {
    XUI_PANEL_ORIGIN: 'https://panel.example.com:14365',
    XUI_WEB_BASE_PATH: 'secretPath',
    XUI_USERNAME: 'admin',
    XUI_PASSWORD: 'pass',
  };

  return {
    get: jest.fn((key: string) => env[key]),
  };
}

function makeProxyConfigService(): Pick<ConfigService, 'get'> {
  const env: Record<string, string> = {
    XUI_PANEL_ORIGIN: 'https://panel.example.com:14365',
    XUI_WEB_BASE_PATH: 'secretPath',
    XUI_USERNAME: 'admin',
    XUI_PASSWORD: 'pass',
    XUI_PUBLIC_HOST: 'net.booksman.tech',
    XUI_PUBLIC_PORT: '443',
    XUI_PUBLIC_SECURITY: 'tls',
  };

  return {
    get: jest.fn((key: string) => env[key]),
  };
}

function makeLoginResponse(): AxiosResponse {
  return {
    data: {},
    status: 200,
    statusText: 'OK',
    headers: {
      'set-cookie': ['3x-ui=session-cookie; Path=/; HttpOnly'],
    },
    config: {} as AxiosResponse['config'],
  };
}

function makeAxiosError(status: number): AxiosError {
  return new AxiosError(
    `HTTP ${status}`,
    'ERR_BAD_RESPONSE',
    {} as AxiosError['config'],
    undefined,
    {
      data: {},
      status,
      statusText: 'ERR',
      headers: {},
      config: {} as AxiosResponse['config'],
    },
  );
}

describe('XuiService', () => {
  let service: XuiService;
  let http: MockHttp;

  beforeEach(() => {
    http = {
      post: jest.fn().mockReturnValue(of(makeLoginResponse())),
      request: jest.fn(),
    };

    service = new XuiService(
      http as unknown as HttpService,
      makeConfigService() as ConfigService,
    );
  });

  it('logs in and lists inbounds with cookie header', async () => {
    http.request.mockReturnValue(
      of({
        data: {
          success: true,
          msg: '',
          obj: [defaultInbound],
        },
      }),
    );

    const inbounds = await service.listInbounds();

    expect(inbounds).toHaveLength(1);
    expect(inbounds[0].id).toBe(2);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.request).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://panel.example.com:14365/secretPath/panel/api',
        url: '/inbounds/list',
        headers: expect.objectContaining({
          Cookie: expect.stringContaining('3x-ui=session-cookie'),
        }),
      }),
    );
  });

  it('re-logins and retries request on 401', async () => {
    http.request
      .mockReturnValueOnce(throwError(() => makeAxiosError(401)))
      .mockReturnValueOnce(
        of({
          data: {
            success: true,
            msg: '',
            obj: [],
          },
        }),
      );

    const inbounds = await service.listInbounds();

    expect(inbounds).toEqual([]);
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('sends the expected disable payload', async () => {
    http.request.mockReturnValue(
      of({
        data: {
          success: true,
          msg: 'ok',
          obj: null,
        },
      }),
    );

    await service.disableClient(2, 'client-42');

    expect(http.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/inbounds/updateClient/client-42',
        data: expect.objectContaining({
          id: 2,
          settings: expect.any(String),
        }),
      }),
    );

    const payload = JSON.parse(http.request.mock.calls[0][0].data.settings) as {
      clients: Array<{ id: string; enable: boolean }>;
    };
    expect(payload.clients).toEqual([{ id: 'client-42', enable: false }]);
  });

  it('sends the expected enable payload with expiry time', async () => {
    http.request.mockReturnValue(
      of({
        data: {
          success: true,
          msg: 'ok',
          obj: null,
        },
      }),
    );

    const expiryTime = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await service.enableClient(2, 'client-42', expiryTime);

    expect(http.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/inbounds/updateClient/client-42',
        data: expect.objectContaining({
          id: 2,
          settings: expect.any(String),
        }),
      }),
    );

    const payload = JSON.parse(http.request.mock.calls[0][0].data.settings) as {
      clients: Array<{ id: string; enable: boolean; expiryTime: number }>;
    };
    expect(payload.clients).toEqual([{ id: 'client-42', enable: true, expiryTime }]);
  });

  it('falls back to no-flow when inbound rejects flow', async () => {
    let listCalls = 0;
    let addCalls = 0;

    http.request.mockImplementation((config: { url: string; data?: unknown }) => {
      if (config.url === '/inbounds/list') {
        listCalls += 1;
        if (listCalls === 1) {
          return of({
            data: {
              success: true,
              msg: '',
              obj: [defaultInbound],
            },
          });
        }

        const refreshedInbound: XuiInbound = {
          ...defaultInbound,
          settings: JSON.stringify({
            clients: [
              { id: 'seed-id', email: 'seed@example.com', flow: 'xtls-rprx-vision' },
              { id: 'new-id', email: 'fresh@example.com', subId: 'sub-fresh', flow: '' },
            ],
            encryption: 'mlkem768x25519plus.native.0rtt.test',
          }),
        };

        return of({
          data: {
            success: true,
            msg: '',
            obj: [refreshedInbound],
          },
        });
      }

      if (config.url === '/inbounds/addClient') {
        addCalls += 1;
        const payload = JSON.parse((config.data as { settings: string }).settings) as {
          clients: Array<{ flow?: string }>;
        };

        if (addCalls === 1) {
          expect(payload.clients[0].flow).toBe('xtls-rprx-vision');
          return throwError(() => makeAxiosError(500));
        }

        expect(payload.clients[0].flow).toBeUndefined();
        return of({
          data: {
            success: true,
            msg: '',
            obj: null,
          },
        });
      }

      throw new Error(`Unexpected URL in mock: ${config.url}`);
    });

    const result = await service.createConfigOnInbound({
      inboundId: 2,
      email: 'fresh@example.com',
      totalGB: 10 * 1024 * 1024 * 1024,
      limitIp: 1,
      days: 30,
    });

    expect(addCalls).toBe(2);
    expect(result.uuid).toBe('new-id');
    expect(result.subId).toBe('sub-fresh');
    expect(result.vlessUrl).toContain('security=reality');
    expect(result.vlessUrl).toContain('encryption=mlkem768x25519plus.native.0rtt.test');
  });

  it('builds WS+TLS URL when proxy env vars are set', async () => {
    const wsInbound: XuiInbound = {
      id: 5,
      remark: 'ws-proxy',
      up: 0,
      down: 0,
      total: 0,
      enable: true,
      port: 10080,
      protocol: 'vless',
      settings: JSON.stringify({
        clients: [{ id: 'seed-ws', email: 'seed@ws.local', flow: '' }],
        encryption: 'none',
      }),
      streamSettings: JSON.stringify({
        network: 'ws',
        security: 'none',
        wsSettings: {
          path: '/secret-tunnel',
          headers: {},
        },
      }),
    };

    const proxyHttp: MockHttp = {
      post: jest.fn().mockReturnValue(of(makeLoginResponse())),
      request: jest.fn(),
    };
    const proxyService = new XuiService(
      proxyHttp as unknown as HttpService,
      makeProxyConfigService() as ConfigService,
    );

    let listCalls = 0;
    proxyHttp.request.mockImplementation((config: { url: string }) => {
      if (config.url === '/inbounds/list') {
        listCalls += 1;
        if (listCalls <= 1) {
          return of({ data: { success: true, msg: '', obj: [wsInbound] } });
        }
        const refreshed: XuiInbound = {
          ...wsInbound,
          settings: JSON.stringify({
            clients: [
              { id: 'seed-ws', email: 'seed@ws.local', flow: '' },
              { id: 'new-ws-id', email: 'ws-user@test.local', subId: 'sub-ws', flow: '' },
            ],
            encryption: 'none',
          }),
        };
        return of({ data: { success: true, msg: '', obj: [refreshed] } });
      }
      if (config.url === '/inbounds/addClient') {
        return of({ data: { success: true, msg: '', obj: null } });
      }
      throw new Error(`Unexpected URL: ${config.url}`);
    });

    const result = await proxyService.createConfigOnInbound({
      inboundId: 5,
      email: 'ws-user@test.local',
      totalGB: 10 * 1024 * 1024 * 1024,
      limitIp: 1,
      days: 30,
    });

    expect(result.uuid).toBe('new-ws-id');
    expect(result.vlessUrl).toContain('net.booksman.tech:443');
    expect(result.vlessUrl).toContain('security=tls');
    expect(result.vlessUrl).toContain('type=ws');
    expect(result.vlessUrl).toContain('path=%2Fsecret-tunnel');
    expect(result.vlessUrl).toContain('host=net.booksman.tech');
    expect(result.vlessUrl).toContain('alpn=h2%2Chttp%2F1.1');
    expect(result.vlessUrl).not.toContain('flow=');
    expect(result.vlessUrl).not.toContain('pbk=');
    expect(result.vlessUrl).not.toContain('sid=');
  });
});
