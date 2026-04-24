import { DatabaseService } from '../database/database.service';
import { TelegramService } from '../telegram/telegram.service';
import { XuiService } from '../xui/xui.service';
import { SubscriptionCronService } from './subscription-cron.service';

describe('SubscriptionCronService', () => {
  let service: SubscriptionCronService;
  let database: jest.Mocked<Pick<DatabaseService, 'findExpiredSubscriptions' | 'findExpiringSubscriptions' | 'expireSubscription'>>;
  let xui: jest.Mocked<Pick<XuiService, 'disableClient'>>;
  let telegram: jest.Mocked<Pick<TelegramService, 'sendSubscriptionExpired' | 'sendExpiryWarning'>>;

  beforeEach(() => {
    database = {
      findExpiredSubscriptions: jest.fn().mockResolvedValue([]),
      findExpiringSubscriptions: jest.fn().mockResolvedValue([]),
      expireSubscription: jest.fn().mockResolvedValue([]),
    };
    xui = {
      disableClient: jest.fn().mockResolvedValue({ success: true, msg: 'ok', obj: null }),
    };
    telegram = {
      sendSubscriptionExpired: jest.fn().mockResolvedValue(undefined),
      sendExpiryWarning: jest.fn().mockResolvedValue(undefined),
    };

    service = new SubscriptionCronService(
      database as unknown as DatabaseService,
      xui as unknown as XuiService,
      telegram as unknown as TelegramService,
    );
  });

  it('does nothing when no expired subscriptions', async () => {
    await service.checkExpiredSubscriptions();
    expect(database.findExpiredSubscriptions).toHaveBeenCalled();
    expect(database.expireSubscription).not.toHaveBeenCalled();
  });

  it('expires subscription, disables client, and notifies user', async () => {
    database.findExpiredSubscriptions.mockResolvedValue([
      {
        id: 'sub-1',
        user: { telegramChatId: BigInt(12345) },
        vpnProfiles: [
          { id: 'prof-1', inboundId: 2, xuiClientId: 'client-uuid-1' },
        ],
      },
    ] as any);

    database.expireSubscription.mockResolvedValue([
      { id: 'prof-1', inboundId: 2, xuiClientId: 'client-uuid-1' },
    ] as any);

    await service.checkExpiredSubscriptions();

    expect(database.expireSubscription).toHaveBeenCalledWith('sub-1');
    expect(xui.disableClient).toHaveBeenCalledWith(2, 'client-uuid-1');
    expect(telegram.sendSubscriptionExpired).toHaveBeenCalledWith(12345);
  });

  it('sends expiry warning for subscriptions expiring within 24h', async () => {
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    database.findExpiringSubscriptions.mockResolvedValue([
      {
        id: 'sub-2',
        expiresAt,
        user: { telegramChatId: BigInt(54321) },
        plan: { title: '1 мес - 299₽' },
      },
    ] as any);

    await service.checkExpiredSubscriptions();

    expect(telegram.sendExpiryWarning).toHaveBeenCalledWith(
      54321,
      '1 мес - 299₽',
      expect.any(Number),
    );
  });

  it('does not run concurrently', async () => {
    let resolveFirst!: () => void;
    database.findExpiredSubscriptions.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = () => resolve([]); }),
    );

    const first = service.checkExpiredSubscriptions();
    const second = service.checkExpiredSubscriptions();

    resolveFirst();
    await first;
    await second;

    expect(database.findExpiredSubscriptions).toHaveBeenCalledTimes(1);
  });
});
