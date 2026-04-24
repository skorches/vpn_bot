import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { ReferralService } from '../referral/referral.service';
import { XuiService } from '../xui/xui.service';
import { TelegramService } from './telegram.service';

describe('TelegramService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  function makeService(configOverrides?: Record<string, string>) {
    const env: Record<string, string> = {
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_POLL_INTERVAL_MS: '2000',
      TELEGRAM_POLL_TIMEOUT_SECONDS: '20',
      TELEGRAM_BOT_USERNAME: 'granit_vpn_bot',
      ...(configOverrides ?? {}),
    };

    const config = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;

    const database = {
      upsertTelegramUser: jest.fn().mockResolvedValue({}),
      getLatestActiveProfileByChatId: jest.fn().mockResolvedValue(null),
      getLatestVlessUrlByChatId: jest.fn().mockResolvedValue(null),
      getActiveSubscriptionByChatId: jest.fn().mockResolvedValue(null),
      getLatestSubscriptionByChatId: jest.fn().mockResolvedValue(null),
      getOrCreateReferralCode: jest.fn().mockResolvedValue('abcDEF12'),
      resolveReferrerChatIdByCode: jest.fn().mockResolvedValue(111),
      createSubscription: jest.fn().mockResolvedValue({
        id: 'sub-1',
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
      renewSubscription: jest.fn().mockResolvedValue({
        id: 'sub-1',
        status: 'ACTIVE',
        expiresAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      reactivateSubscriptionProfiles: jest.fn().mockResolvedValue([]),
      saveProvisionProfile: jest.fn().mockResolvedValue({ profileCode: 'code123' }),
    } as unknown as DatabaseService;

    const referral = {
      attachReferrer: jest.fn().mockResolvedValue({ linked: true, reason: 'linked' }),
    } as unknown as ReferralService;

    const xui = {
      listInbounds: jest.fn().mockResolvedValue([{ id: 2, protocol: 'vless' }]),
      createConfigOnInbound: jest.fn().mockResolvedValue({
        inboundId: 2,
        email: 'tg-333@test.local',
        uuid: 'uuid1',
        subId: 'sub1',
        expiresAt: '2026-01-01T00:00:00.000Z',
        vlessUrl: 'vless://instant',
      }),
      enableClient: jest.fn().mockResolvedValue({ success: true, msg: 'ok', obj: null }),
    } as unknown as XuiService;

    return {
      service: new TelegramService(config, database, referral, xui),
      database,
      referral,
      xui,
    };
  }

  it('pushes config to chat via Telegram API', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { service } = makeService();
    await service.pushConfigToChat(12345, 'vless://example');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('vless://example');
  });

  it('responds to /myconfig with latest config', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { service, database } = makeService();
    (database as any).getLatestVlessUrlByChatId.mockResolvedValue('vless://latest');
    await (service as unknown as { handleUpdate: (u: unknown) => Promise<void> }).handleUpdate({
      update_id: 1,
      message: {
        chat: { id: 333 },
        text: '/myconfig',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(firstCall[1].body)).toContain('vless://latest');
  });

  it('parses /start ref payload and attaches referral', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { service, referral, database } = makeService();
    await (service as unknown as { handleUpdate: (u: unknown) => Promise<void> }).handleUpdate({
      update_id: 2,
      message: {
        chat: {
          id: 333,
          username: 'user_333',
          first_name: 'John',
          last_name: 'Doe',
        },
        text: '/start ref_abCdEf12',
      },
    });

    expect((database as any).upsertTelegramUser).toHaveBeenCalled();
    expect((database as any).resolveReferrerChatIdByCode).toHaveBeenCalledWith('abCdEf12');
    expect((referral as any).attachReferrer).toHaveBeenCalledWith(333, 111);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(firstCall[1].body)).toContain('Выберите действие');
  });

  it('provisions vpn immediately on pay callback', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { service, database, xui } = makeService({ XUI_DEFAULT_INBOUND_ID: '2' });
    await (service as unknown as { handleUpdate: (u: unknown) => Promise<void> }).handleUpdate({
      update_id: 3,
      callback_query: {
        id: 'cbq_1',
        data: 'pay:1m',
        message: {
          message_id: 10,
          chat: { id: 333 },
        },
      },
    });

    expect((xui as any).createConfigOnInbound).toHaveBeenCalled();
    expect((database as any).createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 333,
        planCode: '1m',
        days: 30,
      }),
    );
    expect((database as any).saveProvisionProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub-1',
      }),
    );
    expect(
      fetchMock.mock.calls.some((call) =>
        String((call as [string, RequestInit])[1].body).includes('Профиль готов'),
      ),
    ).toBe(true);
  });

  it('renews active subscription instead of creating new profile', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { service, database, xui } = makeService({ XUI_DEFAULT_INBOUND_ID: '2' });

    (database as any).getLatestSubscriptionByChatId.mockResolvedValue({
      id: 'sub-existing',
      status: 'ACTIVE',
      expiresAt: new Date('2026-02-15T00:00:00.000Z'),
      vpnProfiles: [
        { id: 'prof-1', inboundId: 2, xuiClientId: 'client-1', state: 'ACTIVE', vlessUrl: 'vless://old' },
      ],
    });

    await (service as unknown as { handleUpdate: (u: unknown) => Promise<void> }).handleUpdate({
      update_id: 4,
      callback_query: {
        id: 'cbq_2',
        data: 'pay:1m',
        message: {
          message_id: 11,
          chat: { id: 333 },
        },
      },
    });

    expect((database as any).renewSubscription).toHaveBeenCalledWith('sub-existing', 30);
    expect((xui as any).createConfigOnInbound).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some((call) =>
        String((call as [string, RequestInit])[1].body).includes('продлена'),
      ),
    ).toBe(true);
  });

  it('reactivates expired subscription and re-enables client', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { service, database, xui } = makeService({ XUI_DEFAULT_INBOUND_ID: '2' });

    (database as any).getLatestSubscriptionByChatId.mockResolvedValue({
      id: 'sub-expired',
      status: 'EXPIRED',
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      vpnProfiles: [
        { id: 'prof-2', inboundId: 2, xuiClientId: 'client-2', state: 'DISABLED', vlessUrl: 'vless://expired' },
      ],
    });

    await (service as unknown as { handleUpdate: (u: unknown) => Promise<void> }).handleUpdate({
      update_id: 5,
      callback_query: {
        id: 'cbq_3',
        data: 'pay:3m',
        message: {
          message_id: 12,
          chat: { id: 333 },
        },
      },
    });

    expect((database as any).renewSubscription).toHaveBeenCalledWith('sub-expired', 90);
    expect((xui as any).enableClient).toHaveBeenCalledWith(2, 'client-2', expect.any(Number));
    expect((database as any).reactivateSubscriptionProfiles).toHaveBeenCalledWith('sub-expired');
    expect((xui as any).createConfigOnInbound).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some((call) =>
        String((call as [string, RequestInit])[1].body).includes('восстановлена'),
      ),
    ).toBe(true);
  });
});
