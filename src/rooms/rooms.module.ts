import { Module } from '@nestjs/common';

import { RoomsController } from './rooms.controller';
import { RoomsRepository } from './rooms.repository';
import { RoomsService } from './rooms.service';

/** Аудитории (ТЗ 5.10). `PrismaService` — из глобального модуля. */
@Module({
  controllers: [RoomsController],
  providers: [RoomsService, RoomsRepository],
})
export class RoomsModule {}
