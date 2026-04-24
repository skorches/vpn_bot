import { Body, Controller, Post } from '@nestjs/common';
import { ReferralService } from './referral.service';

type MockPaidDto = {
  invitedChatId: number;
  providerPaymentId: string;
  amount: number;
  currency?: string;
  rewardType?: 'DAYS' | 'BALANCE';
  rewardValue?: number;
};

@Controller('referral')
export class ReferralController {
  constructor(private readonly referralService: ReferralService) {}

  @Post('mock-paid')
  async mockPaid(@Body() body: MockPaidDto) {
    return this.referralService.grantFirstPaymentReward({
      invitedChatId: body.invitedChatId,
      providerPaymentId: body.providerPaymentId,
      amount: body.amount,
      currency: body.currency,
      rewardType: body.rewardType,
      rewardValue: body.rewardValue,
    });
  }
}
