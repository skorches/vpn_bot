import { Inject, Injectable, Logger, OnModuleInit, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { ReferralService } from '../referral/referral.service';
import { XuiService } from '../xui/xui.service';

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id?: number;
      chat?: {
        id: number;
      };
    };
  };
};

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private readonly token: string | null;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutSeconds: number;
  private readonly botUsername: string | null;
  private readonly defaultInboundId: number | null;
  private readonly supportLink: string;
  private readonly v2rayTunAndroidUrl: string;
  private readonly v2rayTunIosUrl: string;
  private readonly v2rayTunWindowsUrl: string;
  private readonly v2rayTunMacosUrl: string;
  private readonly v2rayTunAndroidTvUrl: string;
  private readonly v2rayTunDeepLinkPrefix: string;

  private isPolling = false;
  private offset = 0;
  private lastKeyMessageIdByChatId = new Map<number, number>();
  private provisionCooldown = new Map<number, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly database: DatabaseService,
    private readonly referralService: ReferralService,
    @Inject(forwardRef(() => XuiService))
    private readonly xuiService: XuiService,
  ) {
    this.token = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? null;
    this.pollIntervalMs = Number(this.config.get<string>('TELEGRAM_POLL_INTERVAL_MS') ?? '2000');
    this.pollTimeoutSeconds = Number(this.config.get<string>('TELEGRAM_POLL_TIMEOUT_SECONDS') ?? '20');
    this.botUsername = this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? null;
    this.defaultInboundId = this.parseOptionalInt(this.config.get<string>('XUI_DEFAULT_INBOUND_ID'));
    this.supportLink =
      this.config.get<string>('TELEGRAM_SUPPORT_LINK') ??
      'https://t.me/HelpVPN_robot?start=whwkmZTJ';
    this.v2rayTunAndroidUrl =
      this.config.get<string>('V2RAYTUN_ANDROID_URL') ??
      'https://play.google.com/store/apps/details?id=com.happproxy&hl=ru&pli=1';
    this.v2rayTunIosUrl =
      this.config.get<string>('V2RAYTUN_IOS_URL') ??
      'https://t.me/granit_vpn_bot';
    this.v2rayTunWindowsUrl =
      this.config.get<string>('V2RAYTUN_WINDOWS_URL') ??
      'https://t.me/granit_vpn_bot';
    this.v2rayTunMacosUrl =
      this.config.get<string>('V2RAYTUN_MACOS_URL') ??
      'https://t.me/granit_vpn_bot';
    this.v2rayTunAndroidTvUrl =
      this.config.get<string>('V2RAYTUN_ANDROIDTV_URL') ??
      this.config.get<string>('V2RAYTUN_BASE_URL') ??
      'https://t.me/granit_vpn_bot';
    this.v2rayTunDeepLinkPrefix =
      this.config.get<string>('V2RAYTUN_DEEPLINK_PREFIX') ?? 'v2raytun://import?url=';
  }

  onModuleInit(): void {
    if (!this.token) {
      this.logger.warn('Telegram bot token is not set, bot polling is disabled');
      return;
    }

    this.isPolling = true;
    void this.pollLoop();
    this.logger.log('Telegram bot polling started');
  }

  async pushConfigToChat(chatId: number, vlessUrl: string): Promise<void> {
    await this.sendMessage(
      chatId,
      `Ваш конфиг готов.\n\n${vlessUrl}\n\nИмпортируйте ссылку в клиент.`,
    );
  }

  async sendSubscriptionExpired(chatId: number): Promise<void> {
    await this.sendMessage(
      chatId,
      '⏰ Ваша подписка истекла. VPN-профиль отключен.\n\nОплатите новый тариф, чтобы продолжить пользоваться VPN.',
      {
        replyMarkup: {
          inline_keyboard: [
            [{ text: '💳Продлить VPN', callback_data: 'menu:pay' }],
            [{ text: '💠Главное меню', callback_data: 'menu:main' }],
          ],
        },
      },
    );
  }

  async sendExpiryWarning(chatId: number, planTitle: string, hoursLeft: number): Promise<void> {
    await this.sendMessage(
      chatId,
      `⚠️ Подписка «${planTitle}» истекает через ${hoursLeft} ч.\n\nПродлите сейчас, чтобы не потерять доступ к VPN.`,
      {
        replyMarkup: {
          inline_keyboard: [
            [{ text: '💳Продлить VPN', callback_data: 'menu:pay' }],
            [{ text: '💠Главное меню', callback_data: 'menu:main' }],
          ],
        },
      },
    );
  }

  private async pollLoop(): Promise<void> {
    while (this.isPolling) {
      try {
        await this.pullUpdates();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Telegram polling error: ${message}`);
      }

      await this.sleep(this.pollIntervalMs);
    }
  }

  private async pullUpdates(): Promise<void> {
    const response = await this.telegramRequest<{ ok: boolean; result: TelegramUpdate[] }>(
      'getUpdates',
      {
        offset: this.offset,
        timeout: this.pollTimeoutSeconds,
        allowed_updates: ['message', 'callback_query'],
      },
    );

    if (!response.ok || !Array.isArray(response.result)) {
      return;
    }

    for (const update of response.result) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      await this.handleUpdate(update);
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    const chatId = update.message?.chat?.id;
    const text = update.message?.text?.trim();
    if (!chatId || !text) {
      return;
    }

    if (text.startsWith('/start')) {
      await this.database.upsertTelegramUser({
        chatId,
        username: update.message?.chat?.username ?? null,
        firstName: update.message?.chat?.first_name ?? null,
        lastName: update.message?.chat?.last_name ?? null,
      });
      const referrerCode = this.extractReferrerCode(text);
      if (referrerCode) {
        const referrerChatId = await this.database.resolveReferrerChatIdByCode(referrerCode);
        if (referrerChatId) {
          await this.referralService.attachReferrer(chatId, referrerChatId);
        }
      }

      await this.sendMainMenu(chatId);
      return;
    }

    if (text === '/myconfig') {
      const config = await this.database.getLatestVlessUrlByChatId(chatId);
      if (config) {
        await this.sendMessage(chatId, `Ваш последний конфиг:\n\n${config}`);
        return;
      }

      await this.sendMessage(chatId, 'Пока нет активного профиля. Сначала создайте профиль.');
      return;
    }

  }

  private async sendMessage(
    chatId: number,
    text: string,
    options?: { replyMarkup?: Record<string, unknown>; parseMode?: 'HTML' | 'MarkdownV2' },
  ): Promise<void> {
    await this.telegramRequest('sendMessage', {
      chat_id: chatId,
      text,
      ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
      disable_web_page_preview: true,
      ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    });
  }

  private async sendMessageAndReturnMessageId(
    chatId: number,
    text: string,
    options?: { replyMarkup?: Record<string, unknown>; parseMode?: 'HTML' | 'MarkdownV2' },
  ): Promise<number> {
    const response = await this.telegramRequest<{ ok: boolean; result: { message_id: number } }>(
      'sendMessage',
      {
        chat_id: chatId,
        text,
        ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
        disable_web_page_preview: true,
        ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      },
    );
    return response.result.message_id;
  }

  private async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.telegramRequest('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  private async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    options?: { replyMarkup?: Record<string, unknown>; parseMode?: 'HTML' | 'MarkdownV2' },
  ): Promise<void> {
    await this.telegramRequest('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
      disable_web_page_preview: true,
      ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    });
  }

  private async sendOrEditMessage(
    chatId: number,
    messageId: number | undefined,
    text: string,
    options?: { replyMarkup?: Record<string, unknown>; parseMode?: 'HTML' | 'MarkdownV2' },
  ): Promise<void> {
    const hasMarkup = Boolean(options?.replyMarkup);

    // 1) try edit with markup
    if (messageId) {
      try {
        await this.editMessage(chatId, messageId, text, options);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to edit message ${messageId}, will retry: ${message}`);
      }

      // 2) try edit without markup (common 400 source: invalid URL in inline_keyboard)
      if (hasMarkup) {
        try {
          await this.editMessage(chatId, messageId, text, options?.parseMode ? { parseMode: options.parseMode } : undefined);
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Failed to edit message ${messageId} without markup: ${message}`);
        }
      }
    }

    // 3) try send with markup
    try {
      await this.sendMessage(chatId, text, options);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to send message, will retry without markup: ${message}`);
    }

    // 4) try send without markup
    if (hasMarkup) {
      try {
        await this.sendMessage(chatId, text, options?.parseMode ? { parseMode: options.parseMode } : undefined);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to send message without markup: ${message}`);
      }
    }
  }

  private async telegramRequest<T>(method: string, body: Record<string, unknown>): Promise<T> {
    if (!this.token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    // Error case: Telegram returns JSON with `description`, but keep fallbacks for bad proxies/etc.
    let desc = '';
    try {
      const json = (await response.json()) as unknown;
      if (json && typeof json === 'object' && 'description' in json) {
        desc = String((json as { description?: unknown }).description ?? '');
      } else {
        desc = JSON.stringify(json);
      }
    } catch {
      try {
        desc = await response.text();
      } catch {
        desc = '';
      }
    }

    throw new Error(`Telegram API ${method} failed with status ${response.status}: ${desc}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async buildMainMenuPayload(chatId: number): Promise<{ text: string; replyMarkup: Record<string, unknown> }> {
    let statusLine = '💰 Нет активной подписки.';
    const sub = await this.database.getActiveSubscriptionByChatId(chatId);
    if (sub) {
      const daysLeft = Math.max(0, Math.ceil((sub.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
      const expiresLabel = sub.expiresAt.toLocaleDateString('ru-RU');
      const planTitle = sub.plan?.title ?? 'VPN';
      statusLine = `✅ Подписка: ${planTitle}\n📅 До: ${expiresLabel} (${daysLeft} дн.)`;
    }

    return {
      text: `⚡ Гранит VPN - самый быстрый VPN сервис в РФ.\n\n${statusLine}\n\n🎁 Пригласите друзей в наш VPN и получите 100₽ на баланс за каждого друга.\n\n👇 Выберите действие:`,
      replyMarkup: {
        inline_keyboard: [
          [{ text: sub ? '💳Продлить VPN' : '💳Оплатить VPN', callback_data: 'menu:pay' }],
          [{ text: '🔌Подключиться', callback_data: 'menu:connect' }],
          [{ text: '🎁100₽ за каждого друга', callback_data: 'menu:referral' }],
          [{ text: '🛟Помощь', callback_data: 'menu:help' }],
          [{ text: '📄Оферта', callback_data: 'menu:offer' }],
          [{ text: '💸Заработать с нами', callback_data: 'menu:earn' }],
        ],
      },
    };
  }

  private async sendMainMenu(chatId: number): Promise<void> {
    const payload = await this.buildMainMenuPayload(chatId);
    await this.sendMessage(chatId, payload.text, { replyMarkup: payload.replyMarkup });
  }

  private async sendReferralCard(chatId: number, messageId?: number): Promise<void> {
    const referralLink = await this.getReferralLink(chatId);
    await this.sendOrEditMessage(
      chatId,
      messageId,
      `🎁 Приглашайте друзей и получайте бонус.\n\nВаша ссылка:\n${referralLink}\n\nБонус начисляется после первой успешной оплаты друга.`,
      {
        replyMarkup: {
          inline_keyboard: [
            [{ text: '🔗Поделиться', switch_inline_query: referralLink }],
            [{ text: '💠Главное меню', callback_data: 'menu:main' }],
          ],
        },
      },
    );
  }

  private async handleCallbackQuery(callback: {
    id: string;
    data?: string;
    message?: { message_id?: number; chat?: { id: number } };
  }): Promise<void> {
    const chatId = callback.message?.chat?.id;
    const messageId = callback.message?.message_id;
    const data = callback.data ?? '';

    await this.telegramRequest('answerCallbackQuery', {
      callback_query_id: callback.id,
    });

    if (!chatId) {
      return;
    }

    if (data === 'menu:main') {
      const payload = await this.buildMainMenuPayload(chatId);
      await this.sendOrEditMessage(chatId, messageId, payload.text, {
        replyMarkup: payload.replyMarkup,
      });
      return;
    }
    if (data === 'menu:referral') {
      await this.sendReferralCard(chatId, messageId);
      return;
    }
    if (data === 'menu:pay') {
      await this.sendOrEditMessage(chatId, messageId, '💳 Раздел оплаты. Выберите тариф.', {
        replyMarkup: {
          inline_keyboard: [
            [{ text: '🟡1 мес - 299₽', callback_data: 'pay:1m' }],
            [{ text: '🟢3 мес - 749₽', callback_data: 'pay:3m' }],
            [{ text: '🟣6 мес - 1299₽', callback_data: 'pay:6m' }],
            [{ text: '🔥12 мес - 2299₽', callback_data: 'pay:12m' }],
            [{ text: '💠Главное меню', callback_data: 'menu:main' }],
          ],
        },
      });
      return;
    }
    if (data.startsWith('pay:')) {
      await this.provisionInstantPlan(chatId, messageId, data);
      return;
    }
    if (data === 'menu:connect') {
      await this.sendOrEditMessage(chatId, messageId, 'Выберите свое устройство ниже 👇 для получения инструкции', {
        replyMarkup: {
          inline_keyboard: [
            [{ text: '📎📱Android', callback_data: 'connect:android' }],
            [{ text: '📎📱iOS', callback_data: 'connect:ios' }],
            [{ text: '📎🖥️Windows', callback_data: 'connect:windows' }],
            [{ text: '📎💻macOS', callback_data: 'connect:macos' }],
            [{ text: '📎📺AndroidTV', callback_data: 'connect:androidtv' }],
            [{ text: '💠Главное меню', callback_data: 'menu:main' }],
          ],
        },
      });
      return;
    }
    if (data.startsWith('connect:')) {
      await this.sendDeviceInstallGuide(chatId, messageId, data);
      return;
    }
    if (data === 'cfg:copy') {
      await this.sendLatestConfigForCopy(chatId, messageId);
      return;
    }
    if (data === 'menu:help') {
      await this.sendOrEditMessage(
        chatId,
        messageId,
        '🛟 Помощь. Выберите вопрос или свяжитесь с поддержкой.',
        {
        replyMarkup: {
          inline_keyboard: [[{ text: '💠Главное меню', callback_data: 'menu:main' }]],
        },
        },
      );
      return;
    }
    if (data === 'menu:offer') {
      await this.sendOrEditMessage(
        chatId,
        messageId,
        '📄 Оферта. Ссылку на документ добавим в следующем шаге.',
        {
        replyMarkup: {
          inline_keyboard: [[{ text: '💠Главное меню', callback_data: 'menu:main' }]],
        },
        },
      );
      return;
    }
    if (data === 'menu:earn') {
      await this.sendOrEditMessage(
        chatId,
        messageId,
        '💸 Партнерская программа.\n\nПривлекайте клиентов и получайте процент за продажи и продления.\n\nНажмите кнопку ниже, чтобы получить партнерскую ссылку.',
        {
          replyMarkup: {
            inline_keyboard: [
              [{ text: '🔗Создать партнерскую ссылку', callback_data: 'menu:referral' }],
              [{ text: '💠Главное меню', callback_data: 'menu:main' }],
            ],
          },
        },
      );
      return;
    }
  }

  private extractReferrerCode(startCommand: string): string | null {
    const parts = startCommand.split(' ');
    const payload = parts.length > 1 ? parts[1] : '';
    const match = /^ref_([A-Za-z0-9_-]{6,32})$/.exec(payload);
    if (!match) {
      return null;
    }
    return match[1];
  }

  private async getReferralLink(chatId: number): Promise<string> {
    const referralCode = await this.database.getOrCreateReferralCode(chatId);
    if (this.botUsername) {
      return `https://t.me/${this.botUsername}?start=ref_${referralCode}`;
    }
    return `https://t.me/?start=ref_${referralCode}`;
  }

  private async provisionInstantPlan(
    chatId: number,
    messageId: number | undefined,
    planKey: string,
  ): Promise<void> {
    const now = Date.now();
    const lastProvision = this.provisionCooldown.get(chatId) ?? 0;
    if (now - lastProvision < 30_000) {
      await this.sendOrEditMessage(chatId, messageId, 'Подождите 30 секунд перед повторным запросом.', {
        replyMarkup: {
          inline_keyboard: [[{ text: '💠Главное меню', callback_data: 'menu:main' }]],
        },
      });
      return;
    }
    this.provisionCooldown.set(chatId, now);

    const plan = this.getPlanByCallback(planKey);
    if (!plan) {
      await this.sendOrEditMessage(chatId, messageId, 'Неизвестный тариф. Попробуйте снова.', {
        replyMarkup: {
          inline_keyboard: [[{ text: '💳Назад к тарифам', callback_data: 'menu:pay' }]],
        },
      });
      return;
    }

    await this.sendOrEditMessage(
      chatId,
      messageId,
      `⏳ Создаю VPN-профиль для тарифа "${plan.label}"...`,
    );

    try {
      const existing = await this.database.getLatestSubscriptionByChatId(chatId);
      const canRenew = existing && (existing.status === 'ACTIVE' || existing.status === 'EXPIRED')
        && existing.vpnProfiles.length > 0;

      if (canRenew) {
        await this.handleRenewal(chatId, messageId, plan, existing);
      } else {
        await this.handleNewProvision(chatId, messageId, plan);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Instant provisioning failed for chat ${chatId}: ${message}`);
      await this.sendOrEditMessage(
        chatId,
        messageId,
        'Не удалось выдать профиль автоматически. Попробуйте снова через минуту или напишите в поддержку.',
        {
          replyMarkup: {
            inline_keyboard: [
              [{ text: '🔁Повторить', callback_data: planKey }],
              [{ text: '💠Главное меню', callback_data: 'menu:main' }],
            ],
          },
        },
      );
    }
  }

  private async handleRenewal(
    chatId: number,
    messageId: number | undefined,
    plan: { key: string; label: string; days: number; totalGb: number },
    existing: Awaited<ReturnType<typeof this.database.getLatestSubscriptionByChatId>> & {},
  ): Promise<void> {
    const subscription = await this.database.renewSubscription(existing.id, plan.days);
    const profile = existing.vpnProfiles[0];

    if (existing.status === 'EXPIRED' && profile) {
      const newExpiryTime = subscription.expiresAt.getTime();
      await this.xuiService.enableClient(profile.inboundId, profile.xuiClientId, newExpiryTime);
      await this.database.reactivateSubscriptionProfiles(existing.id);
    }

    const expiresLabel = subscription.expiresAt.toLocaleDateString('ru-RU');
    const vlessUrl = profile?.vlessUrl ?? await this.database.getLatestVlessUrlByChatId(chatId);
    const statusLine = existing.status === 'EXPIRED'
      ? '🔄 Подписка восстановлена!'
      : '🔄 Подписка продлена!';

    await this.sendOrEditMessage(
      chatId,
      messageId,
      `${statusLine}\n\nТариф: ${plan.label}\n+${plan.days} дней\nДействует до: ${expiresLabel}\n\n${vlessUrl ? 'Ваш ключ остался прежним.' : 'Нажмите «🔌Подключиться» для инструкции.'}`,
      {
        replyMarkup: {
          inline_keyboard: [
            [{ text: '🔌Подключиться', callback_data: 'menu:connect' }],
            ...(vlessUrl ? [[{ text: '📋Скопировать ключ', callback_data: 'cfg:copy' }]] : []),
            [{ text: '💠Главное меню', callback_data: 'menu:main' }],
          ],
        },
      },
    );
  }

  private async handleNewProvision(
    chatId: number,
    messageId: number | undefined,
    plan: { key: string; label: string; days: number; totalGb: number },
  ): Promise<void> {
    const inboundId = await this.resolveProvisionInboundId();
    const email = `tg-${chatId}-${Date.now().toString(36)}@granit.local`;
    const totalGB = plan.totalGb * 1024 * 1024 * 1024;

    const created = await this.xuiService.createConfigOnInbound({
      inboundId,
      email,
      totalGB,
      limitIp: 1,
      days: plan.days,
    });

    const subscription = await this.database.createSubscription({
      chatId,
      planCode: plan.key,
      days: plan.days,
      trafficBytes: BigInt(totalGB),
      deviceLimit: 1,
    });

    const profile = await this.database.saveProvisionProfile({
      telegram: {
        chatId,
      },
      profileType: 'STANDARD',
      inboundId: created.inboundId,
      xuiClientId: created.uuid,
      xuiSubId: created.subId,
      vlessUrl: created.vlessUrl,
      subscriptionId: subscription.id,
      metadata: {
        source: 'telegram_instant_pay',
        plan: plan.key,
      },
    });

    const expiresLabel = subscription.expiresAt.toLocaleDateString('ru-RU');
    await this.sendOrEditMessage(
      chatId,
      messageId,
      `✅ Профиль готов!\n\nТариф: ${plan.label}\nСрок: ${plan.days} дней\nДействует до: ${expiresLabel}\nID профиля: ${profile.profileCode}\n\nНажмите «🔌Подключиться», выберите устройство и импортируйте подписку в v2raytun.`,
      {
        replyMarkup: {
          inline_keyboard: [
            [{ text: '🔌Подключиться', callback_data: 'menu:connect' }],
            [{ text: '📋Скопировать ключ', callback_data: 'cfg:copy' }],
            [{ text: '💳Купить ещё', callback_data: 'menu:pay' }],
            [{ text: '💠Главное меню', callback_data: 'menu:main' }],
          ],
        },
      },
    );
  }

  private getPlanByCallback(
    planKey: string,
  ): { key: string; label: string; days: number; totalGb: number } | null {
    if (planKey === 'pay:1m') {
      return { key: '1m', label: '1 мес - 299₽', days: 30, totalGb: 20 + 30 };
    }
    if (planKey === 'pay:3m') {
      return { key: '3m', label: '3 мес - 749₽', days: 90, totalGb: 60 + 30 };
    }
    if (planKey === 'pay:6m') {
      return { key: '6m', label: '6 мес - 1299₽', days: 180, totalGb: 120 + 30 };
    }
    if (planKey === 'pay:12m') {
      return { key: '12m', label: '12 мес - 2299₽', days: 365, totalGb: 240 + 30 };
    }
    return null;
  }

  private async resolveProvisionInboundId(): Promise<number> {
    if (this.defaultInboundId !== null) {
      return this.defaultInboundId;
    }
    const inbounds = await this.xuiService.listInbounds();
    const firstVless = inbounds.find((inbound) => inbound.protocol === 'vless');
    if (firstVless) {
      return firstVless.id;
    }
    if (inbounds[0]) {
      return inbounds[0].id;
    }
    throw new Error('No inbound found for automatic provisioning');
  }

  private parseOptionalInt(value: string | null | undefined): number | null {
    if (!value) {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      throw new Error('XUI_DEFAULT_INBOUND_ID must be integer');
    }
    return parsed;
  }

  private async sendDeviceInstallGuide(
    chatId: number,
    messageId: number | undefined,
    callbackData: string,
  ): Promise<void> {
    const device = callbackData.replace('connect:', '');
    const deviceLabel = this.getDeviceLabel(device);
    if (!deviceLabel) {
      await this.sendOrEditMessage(chatId, messageId, 'Неизвестное устройство. Выберите из списка.', {
        replyMarkup: {
          inline_keyboard: [[{ text: '⬅️Назад', callback_data: 'menu:connect' }]],
        },
      });
      return;
    }

    const config = await this.database.getLatestVlessUrlByChatId(chatId);
    if (!config) {
      await this.sendOrEditMessage(
        chatId,
        messageId,
        `Для подключения на ${deviceLabel} сначала активируйте тариф и получите профиль.\n\nВопросы с оплатой -> ${this.supportLink}`,
        {
          replyMarkup: {
            inline_keyboard: [
              [{ text: '💳Оплатить VPN', callback_data: 'menu:pay' }],
              [{ text: '⬅️Назад', callback_data: 'menu:connect' }],
            ],
          },
        },
      );
      return;
    }

    await this.sendOrEditMessage(
      chatId,
      messageId,
      `1️⃣ Скачайте и установите приложение v2raytun на ${deviceLabel}.\n2️⃣ Нажмите «🔑Показать ключ», скопируйте ключ и импортируйте в v2raytun.\n\nℹ️ Вопросы с оплатой -> ${this.supportLink}`,
      {
        replyMarkup: {
          inline_keyboard: [
            [{ text: '1. 🌐Скачать v2raytun', url: this.getV2RayTunDownloadUrl(device) }],
            [{ text: '2. 🔑Показать ключ', callback_data: 'cfg:copy' }],
            [{ text: '⬅️Назад', callback_data: 'menu:connect' }],
          ],
        },
      },
    );
  }

  private getV2RayTunImportLink(configUrl: string): string {
    // Note: Telegram can reject custom URL schemes in inline keyboard buttons (HTTP 400).
    // If the prefix is not https? or tg://, fall back to the plain subscription URL.
    if (!/^https?:\/\//i.test(this.v2rayTunDeepLinkPrefix) && !/^tg:\/\//i.test(this.v2rayTunDeepLinkPrefix)) {
      return configUrl;
    }
    return `${this.v2rayTunDeepLinkPrefix}${encodeURIComponent(configUrl)}`;
  }

  private getV2RayTunDownloadUrl(device: string): string {
    if (device === 'android') {
      return this.v2rayTunAndroidUrl;
    }
    if (device === 'ios') {
      return this.v2rayTunIosUrl;
    }
    if (device === 'windows') {
      return this.v2rayTunWindowsUrl;
    }
    if (device === 'macos') {
      return this.v2rayTunMacosUrl;
    }
    if (device === 'androidtv') {
      return this.v2rayTunAndroidTvUrl;
    }
    return this.v2rayTunAndroidUrl;
  }

  private getDeviceLabel(device: string): string | null {
    if (device === 'android') {
      return 'Android';
    }
    if (device === 'ios') {
      return 'iOS';
    }
    if (device === 'windows') {
      return 'Windows';
    }
    if (device === 'macos') {
      return 'macOS';
    }
    if (device === 'androidtv') {
      return 'AndroidTV';
    }
    return null;
  }

  private async sendLatestConfigForCopy(chatId: number, messageId: number | undefined): Promise<void> {
    const config = await this.database.getLatestVlessUrlByChatId(chatId);
    if (!config) {
      await this.sendOrEditMessage(chatId, messageId, 'Ключ не найден. Сначала активируйте тариф и создайте профиль.', {
        replyMarkup: {
          inline_keyboard: [
            [{ text: '💳Оплатить VPN', callback_data: 'menu:pay' }],
            [{ text: '💠Главное меню', callback_data: 'menu:main' }],
          ],
        },
      });
      return;
    }

    // Delete previous "copy key" message to avoid chat spam.
    const lastKeyMessageId = this.lastKeyMessageIdByChatId.get(chatId);
    if (lastKeyMessageId) {
      try {
        await this.deleteMessage(chatId, lastKeyMessageId);
      } catch {
        // ignore (message may already be deleted / too old)
      }
    }

    const newMessageId = await this.sendMessageAndReturnMessageId(
      chatId,
      `🔑 Ваш ключ:\n\n<code>${this.escapeHtml(config)}</code>\n\nСкопируйте и импортируйте в v2raytun.`,
      {
        parseMode: 'HTML',
        replyMarkup: {
          inline_keyboard: [[{ text: '💠Главное меню', callback_data: 'menu:main' }]],
        },
      },
    );
    this.lastKeyMessageIdByChatId.set(chatId, newMessageId);
  }

  private escapeHtml(input: string): string {
    return input
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }
}
