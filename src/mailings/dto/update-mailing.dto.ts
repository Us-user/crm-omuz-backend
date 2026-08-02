import { PartialType } from '@nestjs/swagger';

import { CreateMailingDto } from './create-mailing.dto';

/**
 * Правка рассылки (ТЗ 5.19). Только **черновика**: отправленная рассылка —
 * строка истории, и менять её текст задним числом значило бы расходиться
 * с тем, что люди уже прочитали (422). Тот же жизненный цикл, что
 * у финализированной недели журнала (0018), подтверждённой ведомости (0032)
 * и архивного финансового периода (0033).
 */
export class UpdateMailingDto extends PartialType(CreateMailingDto) {}
