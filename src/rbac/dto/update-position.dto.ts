import { PartialType } from '@nestjs/swagger';

import { CreatePositionDto } from './create-position.dto';

/**
 * Правка позиции. Все поля необязательны; переданный `permissions` **заменяет**
 * набор галочек целиком — «добавить одно право» на экране выглядит как сохранение
 * всего списка, и частичное слияние здесь означало бы, что снять галочку нельзя.
 */
export class UpdatePositionDto extends PartialType(CreatePositionDto) {}
