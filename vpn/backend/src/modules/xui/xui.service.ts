import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosRequestConfig } from 'axios';
import { lastValueFrom } from 'rxjs';
import { randomUUID } from 'node:crypto';
import {
  CreateInboundConfigInput,
  CreatedInboundConfig,
  CreateAntiConfigInput,
  CreatedAntiConfig,
  XuiClientPayload,
  XuiInbound,
  XuiResponse,
  XuiSessionState,
} from './xui.types';

class AsyncMutex {
  private current = Promise.resolve();

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.current;
    let release!: () => void;
    this.current = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

@Injectable()
export class XuiService {
  private readonly logger = new Logger(XuiService.name);
  private readonly authMutex = new AsyncMutex();

  private readonly panelOrigin: string;
  private readonly webBasePath: string;
  private readonly username: string;
  private readonly password: string;
  private readonly antiTemplateInboundId: number | null;
  private readonly publicHost: string;
  private readonly publicPort: number | null;
  private readonly publicSecurity: string | null;

  private sessionCookie: string | null = null;
  private lastLoginAt: Date | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.panelOrigin = this.mustGet('XUI_PANEL_ORIGIN').replace(/\/+$/, '');
    this.webBasePath = this.normalizePath(this.mustGet('XUI_WEB_BASE_PATH'));
    this.username = this.mustGet('XUI_USERNAME');
    this.password = this.mustGet('XUI_PASSWORD');
    this.antiTemplateInboundId = this.getOptionalNumber('XUI_ANTI_TEMPLATE_INBOUND_ID');
    this.publicPort = this.getOptionalNumber('XUI_PUBLIC_PORT');
    const configuredPublicHost = this.config.get<string>('XUI_PUBLIC_HOST');
    this.publicHost =
      configuredPublicHost && configuredPublicHost.trim().length > 0
        ? configuredPublicHost.trim()
        : new URL(this.panelOrigin).hostname;
    const securityOverride = this.config.get<string>('XUI_PUBLIC_SECURITY');
    this.publicSecurity =
      securityOverride && securityOverride.trim().length > 0
        ? securityOverride.trim()
        : null;

    if (!configuredPublicHost?.trim()) {
      const panelHostname = new URL(this.panelOrigin).hostname;
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(panelHostname)) {
        this.logger.warn(
          `XUI_PUBLIC_HOST is not set; generated vless:// links use the panel hostname "${panelHostname}". ` +
            `Clients usually need your real VPN endpoint (domain or IP) — set XUI_PUBLIC_HOST to match what users connect to.`,
        );
      }
    }
  }

  async getSessionState(): Promise<XuiSessionState> {
    return {
      hasSession: this.sessionCookie !== null,
      lastLoginAt: this.lastLoginAt?.toISOString() ?? null,
    };
  }

  async listInbounds(): Promise<XuiInbound[]> {
    const response = await this.request<XuiResponse<XuiInbound[]>>({
      method: 'GET',
      url: '/inbounds/list',
    });
    return response.obj ?? [];
  }

  async addClient(inboundId: number, data: Omit<XuiClientPayload, 'id' | 'subId'>) {
    const client = {
      ...data,
      id: randomUUID(),
    };

    return this.request<XuiResponse<unknown>>({
      method: 'POST',
      url: '/inbounds/addClient',
      data: {
        id: inboundId,
        settings: JSON.stringify({
          clients: [client],
        }),
      },
    });
  }

  async createAntiConfig(input: CreateAntiConfigInput): Promise<CreatedAntiConfig> {
    const inbounds = await this.listInbounds();
    const templateInbound = this.pickTemplateInbound(inbounds);
    const streamSettings = JSON.parse(templateInbound.streamSettings);
    const sniffing = templateInbound.sniffing
      ? JSON.parse(templateInbound.sniffing)
      : {
          enabled: false,
          destOverride: ['http', 'tls', 'quic', 'fakedns'],
          metadataOnly: false,
          routeOnly: false,
        };

    const inboundRemark = `anti-${Date.now().toString().slice(-6)}`;
    const antiStreamSettings = {
      ...streamSettings,
      network: 'tcp',
      security: 'reality',
      realitySettings: {
        ...streamSettings.realitySettings,
        settings: {
          ...streamSettings.realitySettings?.settings,
          fingerprint: 'edge',
          spiderX: '/',
        },
      },
    };

    const createdInbound = await this.createInboundWithPortRetry({
      remark: inboundRemark,
      protocol: 'vless',
      streamSettings: antiStreamSettings,
      sniffing,
    });

    const uuid = randomUUID();
    const subId = this.generateSubId();
    const expiryTime = Date.now() + input.days * 24 * 60 * 60 * 1000;

    const client: XuiClientPayload = {
      id: uuid,
      email: input.email,
      enable: true,
      flow: 'xtls-rprx-vision',
      totalGB: input.totalGB,
      expiryTime,
      limitIp: input.limitIp,
      subId,
      tgId: '',
      reset: 0,
    };

    const addClientResponse = await this.request<XuiResponse<unknown>>({
      method: 'POST',
      url: '/inbounds/addClient',
      data: {
        id: createdInbound.id,
        settings: JSON.stringify({
          clients: [client],
        }),
      },
    });
    this.ensureSuccess(addClientResponse, 'Unable to add anti client');

    const freshInbound = await this.getInboundById(createdInbound.id);
    const inboundSettings = JSON.parse(freshInbound.settings);
    const inboundStream = JSON.parse(freshInbound.streamSettings);
    const createdClient = (inboundSettings.clients ?? []).find(
      (existing: { email: string }) => existing.email === input.email,
    ) as XuiClientPayload | undefined;

    if (!createdClient) {
      throw new Error(`Client ${input.email} was not found after creation`);
    }

    const sni =
      inboundStream.realitySettings?.serverNames?.[0] ??
      inboundStream.realitySettings?.target?.split(':')?.[0] ??
      '';
    const sid =
      inboundStream.realitySettings?.shortIds?.find(
        (id: string) => typeof id === 'string' && id.length > 0,
      ) ?? '';
    const fp = inboundStream.realitySettings?.settings?.fingerprint ?? 'edge';
    const pbk = inboundStream.realitySettings?.settings?.publicKey ?? '';
    const spiderX = inboundStream.realitySettings?.settings?.spiderX ?? '/';

    const vlessUrl = this.buildVlessUrl({
      uuid: createdClient.id,
      host: this.publicHost,
      port: freshInbound.port,
      security: 'reality',
      network: 'tcp',
      encryption: 'none',
      sni,
      fp,
      pbk,
      sid,
      spiderX,
      flow: createdClient.flow ?? 'xtls-rprx-vision',
      email: input.email,
      remark: input.remark,
    });

    return {
      inboundId: freshInbound.id,
      inboundRemark,
      email: input.email,
      uuid: createdClient.id,
      subId: createdClient.subId ?? subId,
      expiresAt: new Date(expiryTime).toISOString(),
      vlessUrl,
    };
  }

  async createConfigOnInbound(input: CreateInboundConfigInput): Promise<CreatedInboundConfig> {
    const inbound = await this.getInboundById(input.inboundId);
    const inboundSettings = JSON.parse(inbound.settings);
    const inboundStream = JSON.parse(inbound.streamSettings);

    const uuid = randomUUID();
    const subId = this.generateSubId();
    const expiryTime = Date.now() + input.days * 24 * 60 * 60 * 1000;
    const flow = input.flow?.trim() || this.getPreferredInboundFlow(inboundSettings);

    const baseClient: XuiClientPayload = {
      id: uuid,
      email: input.email,
      enable: true,
      totalGB: input.totalGB,
      expiryTime,
      limitIp: input.limitIp,
      subId,
      tgId: '',
      reset: 0,
    };

    const candidateClient: XuiClientPayload = flow ? { ...baseClient, flow } : { ...baseClient };
    let addClientResponse: XuiResponse<unknown>;

    try {
      addClientResponse = await this.addClientOnInbound(inbound.id, candidateClient);
      if (!addClientResponse.success && candidateClient.flow) {
        this.logger.warn(
          `Inbound ${inbound.id} rejected flow "${candidateClient.flow}", retrying without flow`,
        );
        addClientResponse = await this.addClientOnInbound(inbound.id, baseClient);
      }
    } catch (error) {
      const status = this.getHttpStatus(error);
      if (status === 500 && candidateClient.flow) {
        this.logger.warn(
          `Inbound ${inbound.id} returned 500 for flow "${candidateClient.flow}", retrying without flow`,
        );
        addClientResponse = await this.addClientOnInbound(inbound.id, baseClient);
      } else {
        throw error;
      }
    }

    this.ensureSuccess(addClientResponse, 'Unable to add client on inbound');

    const freshInbound = await this.getInboundById(inbound.id);
    const freshSettings = JSON.parse(freshInbound.settings);
    const freshStream = JSON.parse(freshInbound.streamSettings);
    const createdClient = (freshSettings.clients ?? []).find(
      (existing: { email: string }) => existing.email === input.email,
    ) as XuiClientPayload | undefined;

    if (!createdClient) {
      throw new Error(`Client ${input.email} was not found after creation`);
    }

    const network = freshStream.network ?? 'tcp';
    const isWs = network === 'ws';
    const encryption = this.getVlessEncryptionParam(freshSettings);

    if (network !== 'tcp' && network !== 'ws') {
      this.logger.warn(
        `Inbound ${inbound.id} uses network "${network}"; share-link generation is only validated for tcp and ws. ` +
          `Set XUI_DEFAULT_INBOUND_ID to a tcp/ws inbound or expect a possibly incomplete vless URL.`,
      );
    }

    // For WS+proxy: security on Xray is "none" but clients connect via TLS to the proxy
    const effectiveSecurity = this.publicSecurity ?? freshStream.security ?? 'none';
    const effectivePort = this.publicPort ?? freshInbound.port;

    // Reality params (only relevant for non-WS)
    const sni = isWs
      ? (effectiveSecurity === 'tls' ? this.publicHost : '')
      : (freshStream.realitySettings?.serverNames?.[0] ??
         freshStream.realitySettings?.target?.split(':')?.[0] ?? '');
    const sid = isWs
      ? ''
      : (freshStream.realitySettings?.shortIds?.find(
          (id: string) => typeof id === 'string' && id.length > 0,
        ) ?? '');
    const fp = isWs
      ? 'chrome'
      : (freshStream.realitySettings?.settings?.fingerprint ?? 'chrome');
    const pbk = isWs
      ? ''
      : (freshStream.realitySettings?.settings?.publicKey ?? '');
    const spiderX = isWs
      ? ''
      : (freshStream.realitySettings?.settings?.spiderX ?? '/');

    if (!isWs && effectiveSecurity === 'reality' && !sid) {
      this.logger.warn(
        `Inbound ${inbound.id} has security=reality but no shortId (sid) in streamSettings; the vless link may not connect. Check Reality short IDs in 3x-ui.`,
      );
    }

    // WS params (read from inbound's wsSettings)
    const wsPath = isWs ? (freshStream.wsSettings?.path ?? '') : '';
    const wsHost = isWs ? this.publicHost : '';
    const alpn = isWs && effectiveSecurity === 'tls' ? 'h2,http/1.1' : '';

    // WS transport doesn't support flow
    const clientFlow = isWs ? '' : (createdClient.flow ?? '');

    const vlessUrl = this.buildVlessUrl({
      uuid: createdClient.id,
      host: this.publicHost,
      port: effectivePort,
      security: effectiveSecurity,
      network,
      encryption,
      sni,
      fp,
      pbk,
      sid,
      spiderX,
      flow: clientFlow,
      email: input.email,
      remark: input.remark,
      wsPath,
      wsHost,
      alpn,
    });

    return {
      inboundId: freshInbound.id,
      email: input.email,
      uuid: createdClient.id,
      subId: createdClient.subId ?? subId,
      expiresAt: new Date(expiryTime).toISOString(),
      vlessUrl,
    };
  }

  async disableClient(inboundId: number, clientId: string) {
    return this.request<XuiResponse<unknown>>({
      method: 'POST',
      url: `/inbounds/updateClient/${clientId}`,
      data: {
        id: inboundId,
        settings: JSON.stringify({
          clients: [
            {
              id: clientId,
              enable: false,
            },
          ],
        }),
      },
    });
  }

  async enableClient(inboundId: number, clientId: string, expiryTime: number) {
    return this.request<XuiResponse<unknown>>({
      method: 'POST',
      url: `/inbounds/updateClient/${clientId}`,
      data: {
        id: inboundId,
        settings: JSON.stringify({
          clients: [
            {
              id: clientId,
              enable: true,
              expiryTime,
            },
          ],
        }),
      },
    });
  }

  async deleteClient(inboundId: number, clientId: string) {
    return this.request<XuiResponse<unknown>>({
      method: 'POST',
      url: `/inbounds/${inboundId}/delClient/${clientId}`,
    });
  }

  async forceLogin(): Promise<void> {
    await this.login(true);
  }

  private async request<T>(
    config: AxiosRequestConfig,
    authRetried = false,
  ): Promise<T> {
    await this.login();

    try {
      const response = await lastValueFrom(
        this.http.request<T>({
          ...config,
          baseURL: this.getApiBaseUrl(),
          headers: {
            ...(config.headers ?? {}),
            Cookie: this.sessionCookie ?? '',
          },
        }),
      );
      return response.data;
    } catch (error) {
      const status = this.getHttpStatus(error);
      const shouldRelogin = (status === 401 || status === 403) && !authRetried;

      if (!shouldRelogin) {
        throw error;
      }

      this.logger.warn('3x-ui session rejected, re-authenticating and retrying');
      await this.login(true);
      return this.request<T>(config, true);
    }
  }

  private async createInboundWithPortRetry(args: {
    remark: string;
    protocol: string;
    streamSettings: unknown;
    sniffing: unknown;
  }): Promise<XuiInbound> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidatePort = this.randomPort();
      const addInboundResponse = await this.request<XuiResponse<unknown>>({
        method: 'POST',
        url: '/inbounds/add',
        data: {
          up: 0,
          down: 0,
          total: 0,
          enable: true,
          expiryTime: 0,
          listen: '',
          port: candidatePort,
          protocol: args.protocol,
          remark: args.remark,
          settings: JSON.stringify({
            clients: [],
            decryption: 'none',
          }),
          streamSettings: JSON.stringify(args.streamSettings),
          sniffing: JSON.stringify(args.sniffing),
          allocate: JSON.stringify({
            strategy: 'always',
            refresh: 5,
            concurrency: 3,
          }),
        },
      });

      if (addInboundResponse.success) {
        const createdInbound = await this.getInboundByRemarkAndPort(args.remark, candidatePort);
        if (!createdInbound) {
          throw new Error('Inbound created but not found in list');
        }
        return createdInbound;
      }

      lastError = addInboundResponse.msg;
    }

    throw new Error(`Unable to create anti inbound: ${String(lastError ?? 'unknown error')}`);
  }

  private async addClientOnInbound(
    inboundId: number,
    client: XuiClientPayload,
  ): Promise<XuiResponse<unknown>> {
    return this.request<XuiResponse<unknown>>({
      method: 'POST',
      url: '/inbounds/addClient',
      data: {
        id: inboundId,
        settings: JSON.stringify({
          clients: [client],
        }),
      },
    });
  }

  private async getInboundByRemarkAndPort(remark: string, port: number): Promise<XuiInbound | null> {
    const inbounds = await this.listInbounds();
    return inbounds.find((inbound) => inbound.remark === remark && inbound.port === port) ?? null;
  }

  private async getInboundById(inboundId: number): Promise<XuiInbound> {
    const inbounds = await this.listInbounds();
    const inbound = inbounds.find((item) => item.id === inboundId);
    if (!inbound) {
      throw new Error(`Inbound ${inboundId} not found`);
    }
    return inbound;
  }

  private async login(force = false): Promise<void> {
    if (!force && this.sessionCookie) {
      return;
    }

    await this.authMutex.runExclusive(async () => {
      if (!force && this.sessionCookie) {
        return;
      }

      const loginUrl = this.getLoginUrl();
      this.logger.log(`Authorizing in 3x-ui at ${loginUrl}`);

      const response = await lastValueFrom(
        this.http.post<XuiResponse<unknown>>(
          loginUrl,
          {
            username: this.username,
            password: this.password,
          },
          {
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
          },
        ),
      );

      const setCookie = response.headers['set-cookie'];
      if (!setCookie || setCookie.length === 0) {
        throw new Error('3x-ui login succeeded but no session cookie was returned');
      }

      this.sessionCookie = setCookie.map((cookie) => cookie.split(';')[0]).join('; ');
      this.lastLoginAt = new Date();
    });
  }

  private getApiBaseUrl(): string {
    return `${this.panelOrigin}/${this.webBasePath}/panel/api`;
  }

  private getLoginUrl(): string {
    return `${this.panelOrigin}/${this.webBasePath}/login`;
  }

  private mustGet(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      throw new Error(`Missing required env var: ${key}`);
    }
    return value;
  }

  private getOptionalNumber(key: string): number | null {
    const value = this.config.get<string>(key);
    if (!value) {
      return null;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      throw new Error(`Env var ${key} must be an integer`);
    }
    return parsed;
  }

  private normalizePath(rawPath: string): string {
    return rawPath.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  /** Xray VLESS inbound uses `decryption` in JSON; some exports use `encryption` — both must map to the vless query `encryption` param. */
  private getVlessEncryptionParam(settings: Record<string, unknown>): string {
    const decryption = settings.decryption;
    if (typeof decryption === 'string' && decryption.length > 0) {
      return decryption;
    }
    const encryption = settings.encryption;
    if (typeof encryption === 'string' && encryption.length > 0) {
      return encryption;
    }
    return 'none';
  }

  private getHttpStatus(error: unknown): number | null {
    if (!(error instanceof AxiosError) || !error.response) {
      return null;
    }
    return error.response.status;
  }

  private pickTemplateInbound(inbounds: XuiInbound[]): XuiInbound {
    if (this.antiTemplateInboundId !== null) {
      const explicit = inbounds.find((inbound) => inbound.id === this.antiTemplateInboundId);
      if (explicit) {
        return explicit;
      }
      throw new Error(`Template inbound ${this.antiTemplateInboundId} not found`);
    }

    const firstVless = inbounds.find((inbound) => inbound.protocol === 'vless');
    if (!firstVless) {
      throw new Error('No VLESS inbound found for anti template');
    }
    return firstVless;
  }

  private getPreferredInboundFlow(inboundSettings: { clients?: Array<{ flow?: string }> }): string {
    const clientWithFlow = inboundSettings.clients?.find(
      (client) => typeof client.flow === 'string' && client.flow.length > 0,
    );
    return clientWithFlow?.flow ?? '';
  }

  private ensureSuccess(response: XuiResponse<unknown>, fallback: string): void {
    if (!response.success) {
      throw new Error(`${fallback}: ${response.msg}`);
    }
  }

  private randomPort(): number {
    return 20_000 + Math.floor(Math.random() * 30_000);
  }

  private generateSubId(length = 12): string {
    return randomUUID().replace(/-/g, '').slice(0, length);
  }

  private buildVlessUrl(input: {
    uuid: string;
    host: string;
    port: number;
    security: string;
    network: string;
    encryption: string;
    sni: string;
    fp: string;
    pbk: string;
    sid: string;
    spiderX: string;
    flow: string;
    email: string;
    remark?: string;
    wsPath?: string;
    wsHost?: string;
    alpn?: string;
  }): string {
    const params = new URLSearchParams({
      type: input.network,
      security: input.security,
      encryption: input.encryption,
    });
    if (input.flow) {
      params.set('flow', input.flow);
    }
    if (input.sni) {
      params.set('sni', input.sni);
    }
    if (input.fp) {
      params.set('fp', input.fp);
    }
    if (input.pbk) {
      params.set('pbk', input.pbk);
    }
    if (input.sid) {
      params.set('sid', input.sid);
    }
    if (input.spiderX) {
      params.set('spx', input.spiderX);
    }
    if (input.wsPath) {
      params.set('path', input.wsPath);
    }
    if (input.wsHost) {
      params.set('host', input.wsHost);
    }
    if (input.alpn) {
      params.set('alpn', input.alpn);
    }
    const tag = input.remark?.trim() ? input.remark.trim() : input.email;
    return `vless://${input.uuid}@${input.host}:${input.port}?${params.toString()}#${encodeURIComponent(tag)}`;
  }
}
