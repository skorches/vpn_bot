import { Module, forwardRef } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { XuiModule } from '../xui/xui.module';
import { SubscriptionCronService } from './subscription-cron.service';

@Module({
  imports: [forwardRef(() => TelegramModule), forwardRef(() => XuiModule)],
  providers: [SubscriptionCronService],
  exports: [SubscriptionCronService],
})
export class SubscriptionModule {}
