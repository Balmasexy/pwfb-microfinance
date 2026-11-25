import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

@Injectable()
export class PaystackService {
  private secretKey() {
    const value = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
    if (!value) throw new ServiceUnavailableException('Paystack Secret Key is not configured. Add PAYSTACK_SECRET_KEY to the PWFB backend environment.');
    return value;
  }

  private async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.secretKey()}`);
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json');
    const response = await fetch(`https://api.paystack.co${path}`, { ...init, headers, signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.status === false) {
      throw new BadRequestException(String(payload?.message || `Paystack request failed with status ${response.status}`));
    }
    return payload;
  }

  async listBanks() {
    const payload = await this.request('/bank?country=nigeria&currency=NGN&perPage=100');
    return Array.isArray(payload?.data)
      ? payload.data.map((bank: any) => ({ code: String(bank?.code || '').trim(), name: String(bank?.name || '').trim() })).filter((bank: any) => bank.code && bank.name)
      : [];
  }

  async resolveAccount(bankCode: string, accountNumber: string) {
    const code = String(bankCode || '').trim();
    const number = String(accountNumber || '').replace(/\D/g, '');
    if (!code) throw new BadRequestException('Bank is required');
    if (!/^\d{10}$/.test(number)) throw new BadRequestException('Account number must be exactly 10 digits');
    const payload = await this.request(`/bank/resolve?account_number=${encodeURIComponent(number)}&bank_code=${encodeURIComponent(code)}`);
    const data = payload?.data || {};
    const accountName = String(data.account_name || '').trim();
    if (!accountName) throw new BadRequestException('Paystack could not resolve the account name');
    return { accountNumber: number, accountName, bankCode: code, bankId: data.bank_id ?? null };
  }

  async createCustomer(input: { email: string; firstName: string; lastName: string; phone?: string }) {
    const payload = await this.request('/customer', {
      method: 'POST',
      body: JSON.stringify({ email: input.email, first_name: input.firstName, last_name: input.lastName, ...(input.phone ? { phone: input.phone } : {}) }),
    });
    const code = String(payload?.data?.customer_code || '').trim();
    if (!code) throw new ServiceUnavailableException('Paystack did not return a customer code');
    return { customerCode: code };
  }

  async getCustomer(customerCode: string) {
    const code = String(customerCode || '').trim();
    if (!code) throw new BadRequestException('Paystack customer code is required');
    const payload = await this.request(`/customer/${encodeURIComponent(code)}`);
    const data = payload?.data || {};
    return {
      customerCode: String(data.customer_code || code),
      firstName: String(data.first_name || '').trim(),
      middleName: String(data.middle_name || '').trim(),
      lastName: String(data.last_name || '').trim(),
      email: String(data.email || '').trim(),
      phone: String(data.phone || '').trim(),
      identified: Boolean(data.identified),
    };
  }

  async validateCustomer(input: { customerCode: string; bvn: string; firstName: string; lastName: string; accountNumber: string; bankCode: string; middleName?: string }) {
    const bvn = String(input.bvn || '').replace(/\D/g, '');
    const accountNumber = String(input.accountNumber || '').replace(/\D/g, '');
    if (!/^\d{11}$/.test(bvn)) throw new BadRequestException('BVN must be exactly 11 digits');
    if (!/^\d{10}$/.test(accountNumber)) throw new BadRequestException('Account number must be exactly 10 digits');
    const payload = await this.request(`/customer/${encodeURIComponent(input.customerCode)}/identification`, {
      method: 'POST',
      body: JSON.stringify({ country: 'NG', type: 'bank_account', account_number: accountNumber, bvn, bank_code: input.bankCode, first_name: input.firstName, last_name: input.lastName, ...(input.middleName ? { middle_name: input.middleName } : {}) }),
    });
    return { accepted: Boolean(payload?.status), message: String(payload?.message || 'Customer identification in progress'), customerCode: input.customerCode };
  }

  /** Verify current Paystack-Signature (whsec_) and legacy X-Paystack-Signature. */
  verifyWebhookSignature(rawBody: Buffer, legacySignature?: string, signingSignature?: string) {
    if (!Buffer.isBuffer(rawBody)) return false;
    const signingSecret = String(process.env.PAYSTACK_WEBHOOK_SECRET || '').trim();
    if (signingSignature) {
      if (!signingSecret.startsWith('whsec_')) return false;
      const parts = String(signingSignature).split(',').map((part) => part.trim());
      const timestampPart = parts.find((part) => part.startsWith('t='));
      const timestamp = Number(timestampPart?.slice(2));
      if (!Number.isFinite(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;
      const expected = createHmac('sha512', signingSecret).update(`${timestamp}.`).update(rawBody).digest();
      const candidates = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3).split(':').slice(1).join(':')).filter((value) => /^[a-f0-9]{128}$/i.test(value));
      return candidates.some((candidate) => {
        const actual = Buffer.from(candidate, 'hex');
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      });
    }
    const secret = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
    if (!secret || !legacySignature || !/^[a-f0-9]{128}$/i.test(String(legacySignature).trim())) return false;
    const expected = createHmac('sha512', secret).update(rawBody).digest();
    const actual = Buffer.from(String(legacySignature).trim(), 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  webhookSignatureMode() {
    if (String(process.env.PAYSTACK_WEBHOOK_SECRET || '').trim().startsWith('whsec_')) return 'Paystack-Signature';
    if (String(process.env.PAYSTACK_SECRET_KEY || '').trim()) return 'X-Paystack-Signature (legacy)';
    return null;
  }

  isConfigured() { return Boolean(String(process.env.PAYSTACK_SECRET_KEY || '').trim()); }
}