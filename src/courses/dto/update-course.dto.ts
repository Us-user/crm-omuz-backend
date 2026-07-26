import { PartialType } from '@nestjs/swagger';

import { CreateCourseDto } from './create-course.dto';

/**
 * Правка курса. Все поля необязательны: не переданное остаётся прежним,
 * пустая строка в необязательном текстовом поле очищает его.
 */
export class UpdateCourseDto extends PartialType(CreateCourseDto) {}
