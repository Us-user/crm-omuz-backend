import { Module } from '@nestjs/common';

import { SyllabusController } from './syllabus.controller';
import { SyllabusRepository } from './syllabus.repository';
import { SyllabusService } from './syllabus.service';

/** Силлабус курса и материалы уроков (ТЗ 5.6). `PrismaService` — из глобального модуля. */
@Module({
  controllers: [SyllabusController],
  providers: [SyllabusService, SyllabusRepository],
})
export class SyllabusModule {}
