import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { TelegramService } from '../telegram/telegram.service';
import { XuiService } from './xui.service';

/** Default X-UI client traffic when `totalGB` omitted: original 20 GiB + 30 GiB */
const DEFAULT_TOTAL_GB_BYTES = (20 + 30) * 1024 * 1024 * 1024;

type CreateClientDto = {
  email: string;
  enable: boolean;
  totalGB: number;
  expiryTime: number;
  limitIp: number;
};

type CreateAntiConfigDto = {
  email: string;
  totalGB?: number;
  limitIp?: number;
  days?: number;
  telegramChatId?: number;
};

type CreateInboundConfigDto = {
  email: string;
  totalGB?: number;
  limitIp?: number;
  days?: number;
  flow?: string;
  telegramChatId?: number;
};

@Controller('xui')
export class XuiController {
  constructor(
    private readonly xuiService: XuiService,
    private readonly telegramService: TelegramService,
    private readonly databaseService: DatabaseService,
  ) {}

  @Get('session')
  async getSessionState() {
    return this.xuiService.getSessionState();
  }

  @Post('session/refresh')
  async refreshSession() {
    await this.xuiService.forceLogin();
    return { ok: true };
  }

  @Get('inbounds')
  async listInbounds() {
    return this.xuiService.listInbounds();
  }

  @Post('inbounds/:inboundId/clients')
  async createClient(
    @Param('inboundId', ParseIntPipe) inboundId: number,
    @Body() body: CreateClientDto,
  ) {
    return this.xuiService.addClient(inboundId, body);
  }

  @Patch('inbounds/:inboundId/clients/:clientId/disable')
  async disableInboundClient(
    @Param('inboundId', ParseIntPipe) inboundId: number,
    @Param('clientId') clientId: string,
  ) {
    const response = await this.xuiService.disableClient(inboundId, clientId);
    return {
      ok: response.success,
      msg: response.msg,
    };
  }

  @Delete('inbounds/:inboundId/clients/:clientId')
  async deleteInboundClient(
    @Param('inboundId', ParseIntPipe) inboundId: number,
    @Param('clientId') clientId: string,
  ) {
    const response = await this.xuiService.deleteClient(inboundId, clientId);
    return {
      ok: response.success,
      msg: response.msg,
    };
  }

  @Post('inbounds/:inboundId/provision')
  async provisionInboundClient(
    @Param('inboundId', ParseIntPipe) inboundId: number,
    @Body() body: CreateInboundConfigDto,
  ) {
    const created = await this.xuiService.createConfigOnInbound({
      inboundId,
      email: body.email,
      totalGB: body.totalGB ?? DEFAULT_TOTAL_GB_BYTES,
      limitIp: body.limitIp ?? 1,
      days: body.days ?? 30,
      flow: body.flow,
    });

    if (body.telegramChatId) {
      const profile = await this.databaseService.saveProvisionProfile({
        telegram: {
          chatId: body.telegramChatId,
        },
        profileType: 'STANDARD',
        inboundId: created.inboundId,
        xuiClientId: created.uuid,
        xuiSubId: created.subId,
        vlessUrl: created.vlessUrl,
        metadata: {
          source: 'inbound_provision',
        },
      });
      await this.telegramService.pushConfigToChat(body.telegramChatId, created.vlessUrl);
      return {
        ...created,
        profileCode: profile.profileCode,
      };
    }

    return created;
  }

  @Post('anti-configs')
  async createAntiConfig(@Body() body: CreateAntiConfigDto) {
    const created = await this.xuiService.createAntiConfig({
      email: body.email,
      totalGB: body.totalGB ?? DEFAULT_TOTAL_GB_BYTES,
      limitIp: body.limitIp ?? 1,
      days: body.days ?? 30,
    });

    if (body.telegramChatId) {
      const profile = await this.databaseService.saveProvisionProfile({
        telegram: {
          chatId: body.telegramChatId,
        },
        profileType: 'ANTI',
        inboundId: created.inboundId,
        xuiClientId: created.uuid,
        xuiSubId: created.subId,
        vlessUrl: created.vlessUrl,
        metadata: {
          source: 'anti_provision',
        },
      });
      await this.telegramService.pushConfigToChat(body.telegramChatId, created.vlessUrl);
      return {
        ...created,
        profileCode: profile.profileCode,
      };
    }

    return created;
  }
}
