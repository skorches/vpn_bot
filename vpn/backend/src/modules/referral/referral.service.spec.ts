import { DatabaseService } from '../database/database.service';
import { ReferralService } from './referral.service';

describe('ReferralService', () => {
  it('delegates attachReferrer to database', async () => {
    const database = {
      attachReferral: jest.fn().mockResolvedValue({ linked: true, reason: 'linked' }),
    } as unknown as DatabaseService;

    const service = new ReferralService(database);
    await service.attachReferrer(200, 100);

    expect((database as any).attachReferral).toHaveBeenCalledWith({
      invitedChatId: 200,
      referrerChatId: 100,
      source: 'telegram_start',
    });
  });

  it('delegates first payment reward logic', async () => {
    const database = {
      recordPaidOrderAndGrantReferral: jest.fn().mockResolvedValue({ granted: true }),
    } as unknown as DatabaseService;

    const service = new ReferralService(database);
    await service.grantFirstPaymentReward({
      invitedChatId: 200,
      providerPaymentId: 'pay_1',
      amount: 29900,
      currency: 'RUB',
      rewardType: 'BALANCE',
      rewardValue: 100,
    });

    expect((database as any).recordPaidOrderAndGrantReferral).toHaveBeenCalledWith({
      invitedChatId: 200,
      providerPaymentId: 'pay_1',
      amount: 29900,
      currency: 'RUB',
      rewardType: 'BALANCE',
      rewardValue: 100,
    });
  });
});
