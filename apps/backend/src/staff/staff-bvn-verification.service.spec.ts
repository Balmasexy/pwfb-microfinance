import { createHash } from 'node:crypto';
import { StaffService } from './staff.service';

describe('StaffService Paystack BVN retry behavior', () => {
  const input = { bvn: '20012345678', firstName: 'Uchenna', lastName: 'Okoro', bankCode: '007', accountNumber: '0123456789' };
  const accountHash = createHash('sha256').update('007:0123456789').digest('hex');
  let prisma: { $executeRawUnsafe: jest.Mock; $queryRawUnsafe: jest.Mock };
  let paystack: { resolveAccount: jest.Mock; createCustomer: jest.Mock; validateCustomer: jest.Mock };
  let service: StaffService;

  beforeEach(() => {
    prisma = { $executeRawUnsafe: jest.fn().mockResolvedValue(1), $queryRawUnsafe: jest.fn() };
    paystack = {
      resolveAccount: jest.fn().mockResolvedValue({ accountNumber: input.accountNumber, accountName: 'UCHENNA OKORO', bankCode: input.bankCode }),
      createCustomer: jest.fn().mockResolvedValue({ customerCode: 'CUS_NEW' }),
      validateCustomer: jest.fn().mockResolvedValue({ accepted: true, message: 'Customer Identification in progress' }),
    };
    service = new StaffService({} as any, prisma as any, paystack as any);
  });

  it('resumes an existing pending request without creating or submitting another customer validation', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'row-1', reference: 'CUS_EXISTING', status: 'PENDING', bankCode: input.bankCode, accountNumberHash: accountHash }]);
    const result = await service.initiateBvnVerification(input);
    expect(result).toMatchObject({ pending: true, verified: false, reference: 'CUS_EXISTING' });
    expect(paystack.createCustomer).not.toHaveBeenCalled();
    expect(paystack.validateCustomer).not.toHaveBeenCalled();
  });

  it('reuses the existing Paystack customer when a previous verification failed', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'row-2', reference: 'CUS_RETRY', status: 'FAILED', bankCode: input.bankCode, accountNumberHash: accountHash }]);
    const result = await service.initiateBvnVerification(input);
    expect(result).toMatchObject({ pending: true, reference: 'CUS_RETRY' });
    expect(paystack.createCustomer).not.toHaveBeenCalled();
    expect(paystack.validateCustomer).toHaveBeenCalledWith(expect.objectContaining({ customerCode: 'CUS_RETRY' }));
  });

  it('returns an existing successful verification for the same BVN and bank account', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'row-3', reference: 'CUS_DONE', status: 'COMPLETED', bankCode: input.bankCode, accountNumberHash: accountHash }]);
    const result = await service.initiateBvnVerification(input);
    expect(result).toMatchObject({ verified: true, pending: false, reference: 'CUS_DONE' });
    expect(paystack.createCustomer).not.toHaveBeenCalled();
    expect(paystack.validateCustomer).not.toHaveBeenCalled();
  });
});