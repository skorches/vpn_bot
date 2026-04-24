export type XuiClientPayload = {
  id: string;
  email: string;
  enable: boolean;
  totalGB: number;
  expiryTime: number;
  limitIp: number;
  flow?: string;
  subId?: string;
  tgId?: string;
  reset?: number;
};

export type XuiResponse<T> = {
  success: boolean;
  msg: string;
  obj: T;
};

export type XuiInbound = {
  id: number;
  remark: string;
  up: number;
  down: number;
  total: number;
  enable: boolean;
  port: number;
  protocol: string;
  settings: string;
  streamSettings: string;
  sniffing?: string;
};

export type XuiSessionState = {
  hasSession: boolean;
  lastLoginAt: string | null;
};

export type CreateAntiConfigInput = {
  email: string;
  totalGB: number;
  limitIp: number;
  days: number;
  remark?: string;
};

export type CreatedAntiConfig = {
  inboundId: number;
  inboundRemark: string;
  email: string;
  uuid: string;
  subId: string;
  expiresAt: string;
  vlessUrl: string;
};

export type CreateInboundConfigInput = {
  inboundId: number;
  email: string;
  totalGB: number;
  limitIp: number;
  days: number;
  flow?: string;
  remark?: string;
};

export type CreatedInboundConfig = {
  inboundId: number;
  email: string;
  uuid: string;
  subId: string;
  expiresAt: string;
  vlessUrl: string;
};
