import { PartialType } from '@nestjs/swagger';

import { CreateMentorLevelDto } from './create-mentor-level.dto';

/**
 * Правка ступени. Все поля необязательны: не переданное остаётся прежним,
 * пустая строка в описании очищает его.
 *
 * Правка ставки действует на **все** месяцы, где проставлен этот уровень:
 * история хранит ссылку на ступень, а не копию её ставки (решение сессии 0021).
 */
export class UpdateMentorLevelDto extends PartialType(CreateMentorLevelDto) {}
