import { PartialType } from '@nestjs/swagger';

import { CreateBranchDto } from './create-branch.dto';

/**
 * Правка филиала. Все поля необязательны: не переданное поле остаётся прежним,
 * а пустая строка в необязательном текстовом поле очищает его.
 */
export class UpdateBranchDto extends PartialType(CreateBranchDto) {}
