import { ApiProperty } from '@nestjs/swagger';

/**
 * Ответ на запрос кода. Намеренно не сообщает, нашёлся ли аккаунт: иначе форма
 * восстановления работает как проверка «зарегистрирован ли этот email».
 */
export class ForgotPasswordResponseDto {
  @ApiProperty({
    example: 'Если аккаунт с таким email существует, на него отправлен код восстановления',
    description: 'Один и тот же текст независимо от того, найден аккаунт или нет',
  })
  message!: string;
}

/** Ответ на смену пароля по коду. */
export class ResetPasswordResponseDto {
  @ApiProperty({
    example: 2,
    description: 'Сколько сессий было погашено: после смены пароля вход выполняется заново',
  })
  revokedSessions!: number;
}
