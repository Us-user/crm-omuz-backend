import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

import { trimString } from '../../common';

/** Обмен refresh-токена на новую пару (ТЗ 3.1: ротация). */
export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh-токен, полученный при входе или прошлом обновлении' })
  @Transform(trimString)
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  refreshToken!: string;
}
