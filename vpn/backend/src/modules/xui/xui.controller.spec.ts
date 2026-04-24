import { XuiController } from './xui.controller';
import { XuiService } from './xui.service';

describe('XuiController', () => {
  const service = {
    getSessionState: jest.fn(),
    forceLogin: jest.fn(),
    listInbounds: jest.fn(),
    addClient: jest.fn(),
    disableClient: jest.fn(),
    deleteClient: jest.fn(),
    createConfigOnInbound: jest.fn(),
    createAntiConfig: jest.fn(),
  } as unknown as jest.Mocked<XuiService>;

  const telegramService = {
    pushConfigToChat: jest.fn(),
  };
  const databaseService = {
    saveProvisionProfile: jest.fn(),
  };

  const controller = new XuiController(
    service,
    telegramService as any,
    databaseService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    telegramService.pushConfigToChat.mockResolvedValue(undefined);
    databaseService.saveProvisionProfile.mockResolvedValue({
      profileCode: 'code12345',
    });
  });

  it('returns normalized response for disable endpoint', async () => {
    service.disableClient.mockResolvedValue({
      success: true,
      msg: 'Inbound client has been updated.',
      obj: null,
    });

    const response = await controller.disableInboundClient(2, 'client-123');

    expect(service.disableClient).toHaveBeenCalledWith(2, 'client-123');
    expect(response).toEqual({
      ok: true,
      msg: 'Inbound client has been updated.',
    });
  });

  it('applies defaults for provision endpoint', async () => {
    service.createConfigOnInbound.mockResolvedValue({
      inboundId: 2,
      email: 'test@example.com',
      uuid: 'uuid-1',
      subId: 'sub-1',
      expiresAt: '2026-01-01T00:00:00.000Z',
      vlessUrl: 'vless://example',
    });

    await controller.provisionInboundClient(2, { email: 'test@example.com' });

    expect(service.createConfigOnInbound).toHaveBeenCalledWith({
      inboundId: 2,
      email: 'test@example.com',
      totalGB: 50 * 1024 * 1024 * 1024,
      limitIp: 1,
      days: 30,
      flow: undefined,
    });
  });

  it('sends config to telegram when chat id is provided', async () => {
    service.createConfigOnInbound.mockResolvedValue({
      inboundId: 2,
      email: 'test@example.com',
      uuid: 'uuid-1',
      subId: 'sub-1',
      expiresAt: '2026-01-01T00:00:00.000Z',
      vlessUrl: 'vless://telegram',
    });

    await controller.provisionInboundClient(2, {
      email: 'test@example.com',
      telegramChatId: 12345,
    });

    expect(telegramService.pushConfigToChat).toHaveBeenCalledWith(12345, 'vless://telegram');
    expect(databaseService.saveProvisionProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileType: 'STANDARD',
        inboundId: 2,
        xuiClientId: 'uuid-1',
        xuiSubId: 'sub-1',
        vlessUrl: 'vless://telegram',
      }),
    );
  });

  it('applies defaults for anti config endpoint', async () => {
    service.createAntiConfig.mockResolvedValue({
      inboundId: 10,
      inboundRemark: 'anti-123',
      email: 'anti@example.com',
      uuid: 'uuid-2',
      subId: 'sub-2',
      expiresAt: '2026-01-01T00:00:00.000Z',
      vlessUrl: 'vless://anti',
    });

    await controller.createAntiConfig({ email: 'anti@example.com' });

    expect(service.createAntiConfig).toHaveBeenCalledWith({
      email: 'anti@example.com',
      totalGB: 50 * 1024 * 1024 * 1024,
      limitIp: 1,
      days: 30,
    });
  });

  it('sends anti config to telegram when chat id is provided', async () => {
    service.createAntiConfig.mockResolvedValue({
      inboundId: 10,
      inboundRemark: 'anti-123',
      email: 'anti@example.com',
      uuid: 'uuid-2',
      subId: 'sub-2',
      expiresAt: '2026-01-01T00:00:00.000Z',
      vlessUrl: 'vless://anti-telegram',
    });

    await controller.createAntiConfig({
      email: 'anti@example.com',
      telegramChatId: 54321,
    });

    expect(telegramService.pushConfigToChat).toHaveBeenCalledWith(54321, 'vless://anti-telegram');
    expect(databaseService.saveProvisionProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileType: 'ANTI',
        inboundId: 10,
        xuiClientId: 'uuid-2',
        xuiSubId: 'sub-2',
        vlessUrl: 'vless://anti-telegram',
      }),
    );
  });
});
