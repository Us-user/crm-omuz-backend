import { PartialType } from '@nestjs/swagger';

import { CreateTemplateDto } from './create-template.dto';

/**
 * Правка шаблона (ТЗ 5.19). Не переданное поле остаётся прежним, пустая строка
 * в `channel` снимает привязку к каналу.
 *
 * Правка **не переписывает уже отправленное**: рассылка копирует текст шаблона
 * снимком в момент составления, и связь с шаблоном хранит только происхождение
 * (тот же довод, что у снимка балла выпускника, 0026, и подтверждённой
 * зарплатной ведомости, 0032).
 */
export class UpdateTemplateDto extends PartialType(CreateTemplateDto) {}
