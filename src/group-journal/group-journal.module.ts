import { Module } from '@nestjs/common';

import { GroupJournalController } from './group-journal.controller';
import { GroupJournalRepository } from './group-journal.repository';
import { GroupJournalService } from './group-journal.service';

/**
 * Журнал группы (ТЗ 5.8). Отдельный модуль, а не часть `GroupsModule`, —
 * по той же причине, что менторы, расписание и состав: своя связка, свои
 * правила и свой репозиторий.
 *
 * `StudentCoinsModule` намеренно **не** импортируется: журнал начисляет коины
 * той же транзакцией, что и финализирует неделю, поэтому пишет их таблицы своим
 * репозиторием. Через границу модуля переходит только чистая функция
 * `coinsForWeekSum` — ровно как `deriveStudentStatus` в сессии 0014.
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [GroupJournalController],
  providers: [GroupJournalService, GroupJournalRepository],
})
export class GroupJournalModule {}
