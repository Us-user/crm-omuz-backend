import { PartialType } from '@nestjs/swagger';

import { CreateLessonDto } from './create-lesson.dto';

/**
 * Правка урока. Не переданное поле остаётся прежним, пустая строка
 * в необязательном текстовом поле очищает его.
 *
 * `visibleToGroupIds` **заменяет** набор групп целиком — как галочки прав
 * позиции (сессия 0006): слияние выглядело бы безопаснее, но тогда снять
 * группу с урока было бы нечем, ведь экран сохраняет весь мультивыбор.
 */
export class UpdateLessonDto extends PartialType(CreateLessonDto) {}
