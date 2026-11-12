import { Body, Controller, Headers, Param, Post, Get, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { PaystackBranchDvaService } from './paystack-branch-dva.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller()
export class PaystackBranchDvaController {
  constructor(private readonly service: PaystackBranchDvaService) {}

  @Get('banking/branches/paystack/virtual-accounts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN', 'BRANCH_MANAGER', 'AUDITOR')
  list() { return this.service.list(); }

  @Post('banking/branches/:branchId/paystack/virtual-account')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  provision(@Param('branchId') branchId: string, @Body() body: any) {
    return this.service.provision(branchId, body);
  }

  // Backwards-compatible Test webhook endpoint.
  @Post('webhooks/paystack/branch-dva')
  async testWebhook(@Headers('x-paystack-signature') signature: string, @Req() req: any, @Body() body: any) {
    return this.handleSignedWebhook('test', signature, req, body);
  }

  // Register separate Paystack webhook endpoints for Test and Live.
  @Post('webhooks/paystack/branch-dva/:environment')
  async environmentWebhook(@Param('environment') environment: string, @Headers('x-paystack-signature') signature: string, @Req() req: any, @Body() body: any) {
    if (environment !== 'test' && environment !== 'live') throw new UnauthorizedException('Invalid Paystack webhook environment');
    return this.handleSignedWebhook(environment, signature, req, body);
  }

  private handleSignedWebhook(environment: 'test' | 'live', signature: string, req: any, body: any) {
    const rawBody = req.rawBody as Buffer | undefined;
    if (!rawBody || !this.service.verifyWebhookSignature(rawBody, signature, environment)) {
      throw new UnauthorizedException('Invalid Paystack webhook signature');
    }
    return this.service.handleWebhook(body);
  }
}
