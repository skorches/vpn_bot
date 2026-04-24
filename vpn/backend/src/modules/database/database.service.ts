import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

type TelegramIdentity = {
  chatId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

type SaveProvisionProfileInput = {
  telegram: TelegramIdentity;
  profileType: 'STANDARD' | 'ANTI';
  inboundId: number;
  xuiClientId: string;
  xuiSubId?: string | null;
  vlessUrl?: string | null;
  subscriptionId?: string | null;
  metadata?: Prisma.InputJsonValue;
};

type AttachReferralInput = {
  invitedChatId: number;
  referrerChatId: number;
  source?: string;
};

type RecordPaidOrderInput = {
  invitedChatId: number;
  providerPaymentId: string;
  amount: number;
  currency?: string;
  rewardType?: 'DAYS' | 'BALANCE';
  rewardValue?: number;
};

@Injectable()
export class DatabaseService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertTelegramUser(identity: TelegramIdentity) {
    return this.prisma.user.upsert({
      where: {
        telegramChatId: BigInt(identity.chatId),
      },
      create: {
        telegramChatId: BigInt(identity.chatId),
        telegramUsername: identity.username ?? null,
        telegramFirstName: identity.firstName ?? null,
        telegramLastName: identity.lastName ?? null,
      },
      update: {
        telegramUsername: identity.username ?? null,
        telegramFirstName: identity.firstName ?? null,
        telegramLastName: identity.lastName ?? null,
      },
    });
  }

  async saveProvisionProfile(input: SaveProvisionProfileInput) {
    const user = await this.upsertTelegramUser(input.telegram);
    const profileCode = this.generateProfileCode();

    const profile = await this.prisma.vpnProfile.create({
      data: {
        profileCode,
        userId: user.id,
        inboundId: input.inboundId,
        xuiClientId: input.xuiClientId,
        xuiSubId: input.xuiSubId ?? null,
        vlessUrl: input.vlessUrl ?? null,
        subscriptionId: input.subscriptionId ?? null,
        profileType: input.profileType,
      },
    });

    await this.prisma.provisionEvent.create({
      data: {
        userId: user.id,
        vpnProfileId: profile.id,
        action: 'CREATE',
        status: 'SUCCESS',
        metadata: input.metadata ?? Prisma.JsonNull,
      },
    });

    return profile;
  }

  async getLatestActiveProfileByChatId(chatId: number) {
    return this.prisma.vpnProfile.findFirst({
      where: {
        state: 'ACTIVE',
        user: {
          telegramChatId: BigInt(chatId),
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async getLatestVlessUrlByChatId(chatId: number): Promise<string | null> {
    const profile = await this.prisma.vpnProfile.findFirst({
      where: {
        state: 'ACTIVE',
        vlessUrl: { not: null },
        user: {
          telegramChatId: BigInt(chatId),
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        vlessUrl: true,
      },
    });
    return profile?.vlessUrl ?? null;
  }

  async getOrCreateReferralCode(chatId: number): Promise<string> {
    const user = await this.upsertTelegramUser({ chatId });
    if (user.referralCode) {
      return user.referralCode;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const referralCode = this.generateReferralCode();
      try {
        const updatedUser = await this.prisma.user.update({
          where: { id: user.id },
          data: { referralCode },
        });
        return updatedUser.referralCode as string;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          continue;
        }
        throw error;
      }
    }

    throw new Error('Unable to generate unique referral code');
  }

  async resolveReferrerChatIdByCode(referralCode: string): Promise<number | null> {
    const user = await this.prisma.user.findUnique({
      where: {
        referralCode,
      },
      select: {
        telegramChatId: true,
      },
    });
    if (!user) {
      return null;
    }
    return Number(user.telegramChatId);
  }

  async attachReferral(input: AttachReferralInput) {
    if (input.invitedChatId === input.referrerChatId) {
      return { linked: false, reason: 'self_referral' as const };
    }

    const invitedUser = await this.upsertTelegramUser({
      chatId: input.invitedChatId,
    });
    const referrerUser = await this.upsertTelegramUser({
      chatId: input.referrerChatId,
    });

    const existing = await this.prisma.referral.findUnique({
      where: {
        invitedUserId: invitedUser.id,
      },
    });
    if (existing) {
      return { linked: false, reason: 'already_linked' as const };
    }

    await this.prisma.referral.create({
      data: {
        invitedUserId: invitedUser.id,
        referrerUserId: referrerUser.id,
        source: input.source ?? 'telegram_start',
      },
    });

    return { linked: true, reason: 'linked' as const };
  }

  async recordPaidOrderAndGrantReferral(input: RecordPaidOrderInput) {
    return this.prisma.$transaction(async (tx) => {
      const invitedUser = await tx.user.upsert({
        where: {
          telegramChatId: BigInt(input.invitedChatId),
        },
        create: {
          telegramChatId: BigInt(input.invitedChatId),
        },
        update: {},
      });

      const existingOrder = await tx.order.findUnique({
        where: {
          providerPaymentId: input.providerPaymentId,
        },
      });
      if (existingOrder?.status === 'PAID') {
        return { granted: false, reason: 'duplicate_payment' as const };
      }

      const paidOrdersBefore = await tx.order.count({
        where: {
          userId: invitedUser.id,
          status: 'PAID',
        },
      });

      const order =
        existingOrder === null
          ? await tx.order.create({
              data: {
                userId: invitedUser.id,
                providerPaymentId: input.providerPaymentId,
                status: 'PAID',
                amount: input.amount,
                currency: input.currency ?? 'RUB',
              },
            })
          : await tx.order.update({
              where: {
                id: existingOrder.id,
              },
              data: {
                status: 'PAID',
                amount: input.amount,
                currency: input.currency ?? existingOrder.currency,
              },
            });

      if (paidOrdersBefore > 0) {
        return { granted: false, reason: 'not_first_paid_order' as const, orderId: order.id };
      }

      const referral = await tx.referral.findUnique({
        where: {
          invitedUserId: invitedUser.id,
        },
      });
      if (!referral) {
        return { granted: false, reason: 'no_referrer' as const, orderId: order.id };
      }

      const existingReward = await tx.referralReward.findUnique({
        where: {
          invitedUserId_event: {
            invitedUserId: invitedUser.id,
            event: 'FIRST_PAID_ORDER',
          },
        },
      });
      if (existingReward) {
        return { granted: false, reason: 'already_rewarded' as const, orderId: order.id };
      }

      const reward = await tx.referralReward.create({
        data: {
          referrerUserId: referral.referrerUserId,
          invitedUserId: invitedUser.id,
          orderId: order.id,
          event: 'FIRST_PAID_ORDER',
          rewardType: input.rewardType ?? 'BALANCE',
          rewardValue: input.rewardValue ?? 100,
        },
      });

      return {
        granted: true,
        reason: 'reward_granted' as const,
        orderId: order.id,
        rewardId: reward.id,
      };
    });
  }

  async createSubscription(input: {
    chatId: number;
    planCode: string;
    days: number;
    trafficBytes: bigint;
    deviceLimit: number;
  }) {
    const user = await this.upsertTelegramUser({ chatId: input.chatId });
    const plan = await this.prisma.plan.findUnique({
      where: { code: input.planCode },
    });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.days * 24 * 60 * 60 * 1000);

    return this.prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan?.id ?? null,
        status: 'ACTIVE',
        startsAt: now,
        expiresAt,
        trafficLimitBytes: input.trafficBytes,
        deviceLimit: input.deviceLimit,
      },
    });
  }

  async getActiveSubscriptionByChatId(chatId: number) {
    return this.prisma.subscription.findFirst({
      where: {
        status: 'ACTIVE',
        user: {
          telegramChatId: BigInt(chatId),
        },
      },
      include: {
        plan: true,
      },
      orderBy: {
        expiresAt: 'desc',
      },
    });
  }

  async findExpiredSubscriptions() {
    return this.prisma.subscription.findMany({
      where: {
        status: 'ACTIVE',
        expiresAt: { lt: new Date() },
      },
      include: {
        user: { select: { telegramChatId: true } },
        vpnProfiles: {
          where: { state: 'ACTIVE' },
          select: { id: true, inboundId: true, xuiClientId: true },
        },
      },
    });
  }

  async findExpiringSubscriptions(withinHours: number) {
    const now = new Date();
    const threshold = new Date(now.getTime() + withinHours * 60 * 60 * 1000);
    return this.prisma.subscription.findMany({
      where: {
        status: 'ACTIVE',
        expiresAt: { gt: now, lte: threshold },
      },
      include: {
        user: { select: { telegramChatId: true } },
        plan: { select: { title: true } },
      },
    });
  }

  async expireSubscription(subscriptionId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: { status: 'EXPIRED' },
      });

      const profiles = await tx.vpnProfile.findMany({
        where: {
          subscriptionId,
          state: 'ACTIVE',
        },
      });

      await tx.vpnProfile.updateMany({
        where: {
          subscriptionId,
          state: 'ACTIVE',
        },
        data: { state: 'DISABLED' },
      });

      for (const profile of profiles) {
        await tx.provisionEvent.create({
          data: {
            userId: profile.userId,
            subscriptionId,
            vpnProfileId: profile.id,
            action: 'DISABLE',
            status: 'SUCCESS',
            metadata: { reason: 'subscription_expired' },
          },
        });
      }

      return profiles;
    });
  }

  async renewSubscription(subscriptionId: string, additionalDays: number) {
    return this.prisma.$transaction(async (tx) => {
      const subscription = await tx.subscription.findUniqueOrThrow({
        where: { id: subscriptionId },
      });

      const baseDate = subscription.status === 'ACTIVE' && subscription.expiresAt > new Date()
        ? subscription.expiresAt
        : new Date();

      const newExpiresAt = new Date(baseDate.getTime() + additionalDays * 24 * 60 * 60 * 1000);

      return tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: 'ACTIVE',
          expiresAt: newExpiresAt,
        },
      });
    });
  }

  async reactivateSubscriptionProfiles(subscriptionId: string) {
    return this.prisma.$transaction(async (tx) => {
      const profiles = await tx.vpnProfile.findMany({
        where: {
          subscriptionId,
          state: 'DISABLED',
        },
      });

      await tx.vpnProfile.updateMany({
        where: {
          subscriptionId,
          state: 'DISABLED',
        },
        data: { state: 'ACTIVE' },
      });

      for (const profile of profiles) {
        await tx.provisionEvent.create({
          data: {
            userId: profile.userId,
            subscriptionId,
            vpnProfileId: profile.id,
            action: 'REFRESH',
            status: 'SUCCESS',
            metadata: { reason: 'subscription_renewed' },
          },
        });
      }

      return profiles;
    });
  }

  async getLatestSubscriptionByChatId(chatId: number) {
    return this.prisma.subscription.findFirst({
      where: {
        user: {
          telegramChatId: BigInt(chatId),
        },
      },
      include: {
        plan: true,
        vpnProfiles: {
          select: { id: true, inboundId: true, xuiClientId: true, state: true, vlessUrl: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  private generateProfileCode(): string {
    return randomBytes(6).toString('base64url');
  }

  private generateReferralCode(): string {
    return randomBytes(6).toString('base64url');
  }
}
