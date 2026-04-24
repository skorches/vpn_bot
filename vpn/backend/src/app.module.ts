import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './modules/database/database.module';
import { ReferralModule } from './modules/referral/referral.module';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { XuiModule } from './modules/xui/xui.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{
      ttl: 60_000,
      limit: 20,
    }]),
    DatabaseModule,
    ReferralModule,
    SubscriptionModule,
    TelegramModule,
    XuiModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
