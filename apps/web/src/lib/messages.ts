export type Channel = 'email' | 'sms';
export type RecipientStatus = 'queued' | 'sent' | 'test' | 'failed' | 'skipped';

export interface Counts {
  sent: number;
  test: number;
  failed: number;
  skipped: number;
  queued: number;
  emails: number;
  sms: number;
}

export interface Campaign extends Counts {
  id: string;
  companyId: string;
  companyName: string;
  campaignNr: number;
  name: string;
  sendEmail: boolean;
  sendSms: boolean;
  subject: string | null;
  status: 'sending' | 'done';
  recipientCount: number;
  createdAt: string;
  createdByName: string | null;
}

export interface CampaignRecipient {
  id: string;
  customerId: string | null;
  customerNr: number | null;
  customerName: string;
  channel: Channel;
  recipient: string | null;
  subject: string | null;
  body: string;
  status: RecipientStatus;
  note: string | null;
  sentAt: string | null;
}

export interface CampaignDetail extends Campaign {
  body: string | null;
  smsBody: string | null;
  criteria: Criteria & { excludeCustomerIds?: string[] };
  templateName: string | null;
  sending: boolean;
  recipients: CampaignRecipient[];
}

export interface Criteria {
  propertyIds: string[];
  objectTypes: string[];
  contractTypes: string[];
  contractStatuses: string[];
  includeContacts: boolean;
}

export interface Content {
  sendEmail: boolean;
  sendSms: boolean;
  subject: string;
  body: string;
  smsBody: string;
}

export interface Template {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  subject: string;
  body: string;
  smsBody: string;
  active: boolean;
}

export interface BuiltInTemplate {
  key: string;
  name: string;
  subject: string;
  body: string;
  smsBody: string;
}

export interface DeliveryConfig {
  email: 'brevo' | 'smtp' | 'test';
  sms: 'brevo' | '46elks' | 'test';
  allowlistOnly: boolean;
  fields: { key: string; label: string; example: string }[];
}

export interface PreviewDelivery {
  channel: Channel;
  recipient: string | null;
  owner: string;
  skip: string | null;
  blocked: string | null;
}

export interface PreviewRecipient {
  customerId: string;
  customerNr: number;
  name: string;
  properties: string[];
  objects: string[];
  deliveries: PreviewDelivery[];
  subject: string | null;
  body: string | null;
  smsBody: string | null;
}

export interface Preview {
  recipients: PreviewRecipient[];
  summary: {
    tenants: number;
    emails: number;
    sms: number;
    missingEmail: number;
    missingSms: number;
    smsParts: { chars: number; parts: number; perPart: number; unicode: boolean };
  };
  issues: string[];
  config: DeliveryConfig;
}

export const CONTRACT_STATUS_LABEL: Record<string, string> = {
  current: 'Nuvarande hyresgäster',
  notice: 'Uppsagda, inte utflyttade',
  upcoming: 'Kommande inflyttning',
  ended: 'Tidigare hyresgäster',
};

export const CHANNEL_LABEL: Record<Channel, string> = { email: 'E-post', sms: 'SMS' };

export const RECIPIENT_STATUS: Record<RecipientStatus, { label: string; tone: 'good' | 'warn' | 'neutral' | 'bad' | 'accent' }> = {
  sent: { label: 'Skickat', tone: 'good' },
  test: { label: 'Testläge', tone: 'accent' },
  queued: { label: 'I kö', tone: 'neutral' },
  failed: { label: 'Misslyckades', tone: 'bad' },
  skipped: { label: 'Hoppades över', tone: 'warn' },
};

export function channelsLabel(c: { sendEmail: boolean; sendSms: boolean }): string {
  return [c.sendEmail && 'E-post', c.sendSms && 'SMS'].filter(Boolean).join(' och ');
}
