import { PartialType } from '@nestjs/swagger';

import { CreateRoomDto } from './create-room.dto';

/**
 * Правка аудитории. `branchId` менять разрешено: комнату могут переписать
 * на другой филиал при переезде, а запрет заставил бы заводить её заново
 * и потерять ссылки из расписания.
 */
export class UpdateRoomDto extends PartialType(CreateRoomDto) {}
