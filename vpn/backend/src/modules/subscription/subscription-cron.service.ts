import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { XuiService } from '../xui/xui.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class SubscriptionCronService {
  private readonly logger = new Logger(SubscriptionCronService.name);
  private isRunning = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly xuiService: XuiService,
    private readonly telegramService: TelegramService,
  ) {}

  @Interval(60_000)
  async checkExpiredSubscriptions(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    try {
      await this.processExpired();
      await this.processExpiryWarnings();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Subscription cron failed: ${message}`);
    } finally {
      this.isRunning = false;
    }
  }

  private async processExpired(): Promise<void> {
    const expired = await this.database.findExpiredSubscriptions();
    if (expired.length === 0) {
      return;
    }

    this.logger.log(`Found ${expired.length} expired subscription(s)`);

    for (const subscription of expired) {
      try {
        const profiles = await this.database.expireSubscription(subscription.id);

        for (const profile of profiles) {
          try {
            await this.xuiService.disableClient(profile.inboundId, profile.xuiClientId);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(
              `Failed to disable 3x-ui client ${profile.xuiClientId}: ${msg}`,
            );
          }
        }

        const chatId = Number(subscription.user.telegramChatId);
        await this.telegramService.sendSubscriptionExpired(chatId);

        this.logger.log(
          `Expired subscription ${subscription.id}, disabled ${profiles.length} profile(s)`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to expire subscription ${subscription.id}: ${msg}`);
      }
    }
  }

  private async processExpiryWarnings(): Promise<void> {
    const expiringSoon = await this.database.findExpiringSubscriptions(24);
    if (expiringSoon.length === 0) {
      return;
    }

    for (const subscription of expiringSoon) {
      try {
        const chatId = Number(subscription.user.telegramChatId);
        const hoursLeft = Math.max(
          1,
          Math.round(
            (subscription.expiresAt.getTime() - Date.now()) / (60 * 60 * 1000),
          ),
        );
        const planTitle = subscription.plan?.title ?? 'VPN';
        await this.telegramService.sendExpiryWarning(chatId, planTitle, hoursLeft);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to send expiry warning for ${subscription.id}: ${msg}`);
      }
    }
  }
}
