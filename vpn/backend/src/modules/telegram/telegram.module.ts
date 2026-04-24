import { Module, forwardRef } from '@nestjs/common';
import { ReferralModule } from '../referral/referral.module';
import { XuiModule } from '../xui/xui.module';
import { TelegramService } from './telegram.service';

@Module({
  imports: [ReferralModule, forwardRef(() => XuiModule)],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
