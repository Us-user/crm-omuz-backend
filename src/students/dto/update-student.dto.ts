import { PartialType } from '@nestjs/swagger';

import { CreateStudentDto } from './create-student.dto';

/**
 * Правка карточки студента (ТЗ 5.3). Все поля необязательны: не переданное поле
 * остаётся прежним, пустая строка в необязательном поле очищает его.
 *
 * Телефон очистить нельзя — он обязателен и уникален; пустая строка в нём
 * отвергается как неразобранный номер (400), а не молча пропускается.
 */
export class UpdateStudentDto extends PartialType(CreateStudentDto) {}
