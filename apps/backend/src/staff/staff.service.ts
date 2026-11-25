import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { StaffRepository } from './staff.repository';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { StaffFilterDto } from './dto/staff-filter.dto';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from './paystack.service';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

@Injectable()
export class StaffService {
  constructor(private readonly staffRepository: StaffRepository, private readonly prisma: PrismaService, private readonly paystack: PaystackService) {}
  private normalizeName(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, ''); }
  private async generateLoginEmail(firstName: string, lastName: string) { const base = `${this.normalizeName(firstName)}.${this.normalizeName(lastName)}`; let email = `${base}@pwfb.com`; let counter = 1; while (await this.staffRepository.emailExists(email)) { email = `${base}${counter}@pwfb.com`; counter++; } return email; }
  private generateTemporaryPassword() { return `PWFB-${randomBytes(4).toString('hex').toUpperCase()}-${randomInt(1000, 10000)}`; }
  private async generateStaffId() { const count = await this.staffRepository.count(); let number = count + 1; let staffId = `PWFB-STF-${String(number).padStart(4, '0')}`; while (await this.staffRepository.staffIdExists(staffId)) { number++; staffId = `PWFB-STF-${String(number).padStart(4, '0')}`; } return staffId; }
  private hashBvn(bvn: string) { return createHash('sha256').update(String(bvn).replace(/\D/g, '')).digest('hex'); }

  private async ensureBvnVerificationTable() {
    await this.prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "StaffBvnVerification" ("id" TEXT PRIMARY KEY,"reference" TEXT NOT NULL UNIQUE,"bvnHash" TEXT,"bankCode" TEXT,"accountNumberHash" TEXT,"requestedFirstName" TEXT NOT NULL,"requestedLastName" TEXT NOT NULL,"firstName" TEXT,"middleName" TEXT,"lastName" TEXT,"fullName" TEXT,"status" TEXT NOT NULL DEFAULT 'PENDING',"message" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"verifiedAt" TIMESTAMP(3))`);
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "StaffBvnVerification" ADD COLUMN IF NOT EXISTS "bvnHash" TEXT`);
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "StaffBvnVerification" ADD COLUMN IF NOT EXISTS "bankCode" TEXT`);
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "StaffBvnVerification" ADD COLUMN IF NOT EXISTS "accountNumberHash" TEXT`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StaffBvnVerification_bvnHash_idx" ON "StaffBvnVerification" ("bvnHash")`);
  }

  async paystackBanks() { return this.paystack.listBanks(); }

  async initiateBvnVerification(input: { bvn: string; firstName: string; lastName: string; middleName?: string; bankCode: string; accountNumber: string }) {
    const bvn = String(input.bvn || '').replace(/\D/g, '');
    if (!/^\d{11}$/.test(bvn)) throw new BadRequestException('BVN must be exactly 11 digits');
    const firstName = String(input.firstName || '').trim();
    const lastName = String(input.lastName || '').trim();
    if (!firstName || !lastName) throw new BadRequestException('First name and last name are required');

    const account = await this.paystack.resolveAccount(input.bankCode, input.accountNumber);
    await this.ensureBvnVerificationTable();
    const bvnHash = this.hashBvn(bvn);
    const accountNumberHash = createHash('sha256').update(`${account.bankCode}:${account.accountNumber}`).digest('hex');
    const existingRows = await this.prisma.$queryRawUnsafe<any[]>(`SELECT "id","reference","status","bankCode","accountNumberHash" FROM "StaffBvnVerification" WHERE "bvnHash"=$1 ORDER BY "updatedAt" DESC LIMIT 1`, bvnHash);
    const existing = existingRows[0];
    const sameAccount = Boolean(existing && existing.bankCode === account.bankCode && existing.accountNumberHash === accountNumberHash);

    if (existing && sameAccount && String(existing.status).toUpperCase() === 'COMPLETED') {
      return { verified: true, pending: false, reference: existing.reference, accountName: account.accountName, bankCode: account.bankCode, accountNumber: account.accountNumber, message: 'This BVN and bank account have already been verified.' };
    }
    if (existing && sameAccount && String(existing.status).toUpperCase() === 'PENDING') {
      return { verified: false, pending: true, reference: existing.reference, accountName: account.accountName, bankCode: account.bankCode, accountNumber: account.accountNumber, message: 'Your existing Paystack verification is still processing. Resuming that request.' };
    }

    let customerCode = String(existing?.reference || '').trim();
    if (!customerCode) {
      // The deterministic alias avoids creating a new Paystack customer per retry.
      const email = `pwfb.kyc.${bvnHash.slice(0, 24)}@pwfb.com`;
      const customer = await this.paystack.createCustomer({ email, firstName, lastName });
      customerCode = customer.customerCode;
      // Persist the reference before requesting identification so a fast webhook
      // can always find its local verification row.
      await this.prisma.$executeRawUnsafe(`INSERT INTO "StaffBvnVerification" ("id","reference","bvnHash","bankCode","accountNumberHash","requestedFirstName","requestedLastName","status","message") VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8)`, randomUUID(), customerCode, bvnHash, account.bankCode, accountNumberHash, firstName, lastName, 'Paystack identity verification submitted; waiting for the provider result.');
    } else {
      // Reuse the persisted customer after a rejected attempt or corrected details.
      await this.prisma.$executeRawUnsafe(`UPDATE "StaffBvnVerification" SET "bankCode"=$1,"accountNumberHash"=$2,"requestedFirstName"=$3,"requestedLastName"=$4,"status"='PENDING',"message"=$5,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$6`, account.bankCode, accountNumberHash, firstName, lastName, 'Corrected details submitted to Paystack; waiting for the provider result.', existing.id);
    }

    try {
      const validation = await this.paystack.validateCustomer({ customerCode, bvn, firstName, lastName, middleName: input.middleName?.trim(), accountNumber: account.accountNumber, bankCode: account.bankCode });
      const message = validation.message || 'Paystack accepted the identity verification request. Waiting for verification.';
      await this.prisma.$executeRawUnsafe(`UPDATE "StaffBvnVerification" SET "message"=$1,"updatedAt"=CURRENT_TIMESTAMP WHERE "reference"=$2`, message, customerCode);
      return { verified: false, pending: true, reference: customerCode, accountName: account.accountName, bankCode: account.bankCode, accountNumber: account.accountNumber, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Paystack could not submit the identity verification request.';
      await this.prisma.$executeRawUnsafe(`UPDATE "StaffBvnVerification" SET "status"='FAILED',"message"=$1,"updatedAt"=CURRENT_TIMESTAMP WHERE "reference"=$2`, message, customerCode);
      throw error;
    }
  }

  async getBvnVerification(reference: string) {
    const ref = String(reference || '').trim();
    if (!ref) throw new BadRequestException('Paystack verification reference is required');
    await this.ensureBvnVerificationTable();
    const rows = await this.prisma.$queryRawUnsafe<any[]>(`SELECT "reference","status","requestedFirstName","requestedLastName","firstName","middleName","lastName","fullName","message" FROM "StaffBvnVerification" WHERE "reference"=$1 LIMIT 1`, ref);
    const row = rows[0];
    if (!row) throw new NotFoundException('Paystack BVN verification request not found');
    let status = String(row.status || 'PENDING').toUpperCase();
    let firstName = row.firstName || row.requestedFirstName;
    let middleName = row.middleName || '';
    let lastName = row.lastName || row.requestedLastName;
    let fullName = row.fullName || [firstName, middleName, lastName].filter(Boolean).join(' ');
    let message = row.message || '';

    // Poll the provider record as a fallback when webhook delivery is delayed.
    if (status === 'PENDING' || status === 'COMPLETED') {
      try {
        const customer = await this.paystack.getCustomer(ref);
        if (customer.firstName) firstName = customer.firstName;
        if (customer.middleName) middleName = customer.middleName;
        if (customer.lastName) lastName = customer.lastName;
        fullName = [firstName, middleName, lastName].filter(Boolean).join(' ');
        if (status === 'PENDING' && customer.identified) {
          status = 'COMPLETED';
          message = 'Paystack identity verification confirmed from the customer record.';
          await this.prisma.$executeRawUnsafe(`UPDATE "StaffBvnVerification" SET "firstName"=$1,"middleName"=$2,"lastName"=$3,"fullName"=$4,"status"='COMPLETED',"message"=$5,"updatedAt"=CURRENT_TIMESTAMP,"verifiedAt"=CURRENT_TIMESTAMP WHERE "reference"=$6`, firstName || null, middleName || null, lastName || null, fullName || null, message, ref);
        }
      } catch (_) {
        // Retain the stored state; the signed webhook remains the async update path.
      }
    }
    return { verified: status === 'COMPLETED', pending: status === 'PENDING', reference: row.reference, firstName, middleName, lastName, fullName, status, message };
  }

  async handleBvnWebhook(body: any, legacySignature?: string, rawBody?: Buffer, signingSignature?: string) {
    if (!rawBody || !Buffer.isBuffer(rawBody)) throw new BadRequestException('Paystack webhook raw request body is unavailable.');
    if (!this.paystack.verifyWebhookSignature(rawBody, legacySignature, signingSignature)) {
      throw new BadRequestException('Invalid Paystack webhook signature. Check the Live signing secret or legacy integration secret.');
    }
    const event = String(body?.event || '').toLowerCase();
    if (!['customeridentification.success','customeridentification.failed'].includes(event)) return { ok: true, ignored: true, event };
    const data = body?.data || {};
    const reference = String(data?.customer_code || data?.customerCode || '').trim();
    if (!reference) return { ok: true, ignored: true, reason: 'no-customer-code' };
    await this.ensureBvnVerificationTable();
    const rows = await this.prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "StaffBvnVerification" WHERE "reference" = $1 LIMIT 1`, reference); const row = rows[0];
    if (!row) return { ok: true, ignored: true, reason: 'no-matching-request', reference };
    const failed = event.endsWith('.failed');
    const identification = data?.identification || {};
    let firstName = String(data?.first_name || '').trim();
    let middleName = String(data?.middle_name || '').trim();
    let lastName = String(data?.last_name || '').trim();
    if (!failed) {
      try {
        const customer = await this.paystack.getCustomer(reference);
        firstName = customer.firstName || firstName;
        middleName = customer.middleName || middleName;
        lastName = customer.lastName || lastName;
      } catch (_) {}
    }
    const fullName = [firstName,middleName,lastName].filter(Boolean).join(' ').trim();
    const message = failed ? String(data?.reason || 'Paystack identity verification failed') : 'Paystack identity verification completed';
    await this.prisma.$executeRawUnsafe(`UPDATE "StaffBvnVerification" SET "firstName"=$1,"middleName"=$2,"lastName"=$3,"fullName"=$4,"status"=$5,"message"=$6,"updatedAt"=CURRENT_TIMESTAMP,"verifiedAt"=CASE WHEN $5='COMPLETED' THEN CURRENT_TIMESTAMP ELSE "verifiedAt" END WHERE "id"=$7`, firstName || null, middleName || null, lastName || null, fullName || null, failed ? 'FAILED' : 'COMPLETED', message, row.id);
    return { ok: true, verified: !failed, reference, status: failed ? 'FAILED' : 'COMPLETED', bankCode: identification?.bank_code || null };
  }

  async bvnConfigurationStatus() {
    const baseUrl = String(process.env.PWFB_PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');
    return {
      configured: this.paystack.isConfigured(),
      source: this.paystack.isConfigured() ? 'PAYSTACK_SECRET_KEY' : null,
      webhookConfigured: null,
      webhookRegistration: 'unknown_until_checked_in_paystack_dashboard',
      webhookSignatureReady: Boolean(this.paystack.webhookSignatureMode()),
      webhookSignatureMode: this.paystack.webhookSignatureMode(),
      webhookUrl: baseUrl ? `${baseUrl}/webhooks/staff/bvn/paystack` : null,
      webhookEvents: ['customeridentification.success', 'customeridentification.failed'],
      environment: process.env.NODE_ENV || 'unknown',
      api: 'https://api.paystack.co/customer/:code/identification',
      secretValueExposed: false,
    };
  }

  async create(createStaffDto: CreateStaffDto) {
    const registrationData: any = { ...createStaffDto };
    const reference = String((createStaffDto as any).bvnVerificationReference || '').trim();
    if (!reference) throw new BadRequestException('Complete Paystack BVN and bank-account verification before creating this staff account.');
    const verification = await this.getBvnVerification(reference);
    if (!verification.verified) throw new BadRequestException(verification.message || 'Paystack BVN verification has not completed successfully.');
    delete registrationData.bvn;
    delete registrationData.bvnVerificationReference;
    registrationData.firstName = verification.firstName;
    registrationData.middleName = verification.middleName || undefined;
    registrationData.lastName = verification.lastName;
    const email = await this.generateLoginEmail(registrationData.firstName, registrationData.lastName);
    const temporaryPassword = this.generateTemporaryPassword();
    const password = await bcrypt.hash(temporaryPassword, 10);
    const staffId = createStaffDto.staffId || await this.generateStaffId();
    try {
      const result = await this.staffRepository.createWithUser(registrationData, { staffId, email, password }, undefined);
      return { message: 'Staff created successfully', staff: result.staff, login: { email, temporaryPassword }, bvn: { verified: true, provider: 'PAYSTACK', reference, legalName: verification.fullName } };
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Unable to create staff'); }
  }

  async findAll(filter?: StaffFilterDto) { const staff = await this.staffRepository.findAll(); if (!filter) return staff; return staff.filter((member) => { const departmentMatch = !filter.department || member.department.name === filter.department; const branchMatch = !filter.branch || member.branch.name === filter.branch; const statusMatch = !filter.employmentStatus || member.employmentStatus === filter.employmentStatus; const searchMatch = !filter.search || `${member.firstName} ${member.lastName}`.toLowerCase().includes(filter.search.toLowerCase()); return departmentMatch && branchMatch && statusMatch && searchMatch; }); }
  findOne(id: string) { return this.staffRepository.findOne(id); }
  update(id: string, updateStaffDto: UpdateStaffDto) { return this.staffRepository.update(id, updateStaffDto); }
  remove(id: string) { return this.staffRepository.remove(id); }
  assign(id: string, body: { role: Role; regionId?: string; divisionId?: string; areaId?: string; branchId?: string; notes?: string }) { return this.staffRepository.createAssignment(id, body); }
  assignmentHistory(id: string) { return this.staffRepository.assignmentHistory(id); }
}
