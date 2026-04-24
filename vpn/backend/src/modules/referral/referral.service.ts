import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class ReferralService {
  constructor(private readonly database: DatabaseService) {}

  async attachReferrer(invitedChatId: number, referrerChatId: number) {
    return this.database.attachReferral({
      invitedChatId,
      referrerChatId,
      source: 'telegram_start',
    });
  }

  async grantFirstPaymentReward(input: {
    invitedChatId: number;
    providerPaymentId: string;
    amount: number;
    currency?: string;
    rewardType?: 'DAYS' | 'BALANCE';
    rewardValue?: number;
  }) {
    return this.database.recordPaidOrderAndGrantReferral(input);
  }
}
