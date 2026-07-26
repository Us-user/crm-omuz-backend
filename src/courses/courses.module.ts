import { Module } from '@nestjs/common';

import { CoursesController } from './courses.controller';
import { CoursesRepository } from './courses.repository';
import { CoursesService } from './courses.service';

/** Курсы (ТЗ 5.6). `PrismaService` — из глобального модуля. */
@Module({
  controllers: [CoursesController],
  providers: [CoursesService, CoursesRepository],
})
export class CoursesModule {}
