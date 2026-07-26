import { Module } from '@nestjs/common';

import { BranchesController } from './branches.controller';
import { BranchesRepository } from './branches.repository';
import { BranchesService } from './branches.service';

/**
 * Филиалы (ТЗ 5.17). `PhoneService` и `PrismaService` приходят из глобальных
 * модулей, `PermissionsGuard` — из глобального `RbacModule`.
 */
@Module({
  controllers: [BranchesController],
  providers: [BranchesService, BranchesRepository],
})
export class BranchesModule {}
