import { ApiProperty } from '@nestjs/swagger';

import { DeliveryCountsDto, MailingDto } from './mailing-response.dto';

/**
 * Ответ на отправку и на повтор упавших.
 *
 * Кроме самой рассылки называет, **сколько задач поставлено в очередь**: без
 * этого числа «202 Accepted» не отличалось бы от «принято и ничего не сделано»,
 * а при повторе — не сказало бы, было ли что повторять.
 */
export class MailingSendResultDto {
  @ApiProperty({ type: MailingDto })
  mailing!: MailingDto;

  @ApiProperty({ type: DeliveryCountsDto, description: 'Счётчики сразу после постановки задач.' })
  deliveries!: DeliveryCountsDto;

  @ApiProperty({
    example: 22,
    description:
      'Сколько доставок ушло в очередь. Меньше `deliveries.total` на число получателей ' +
      'без адреса: им отправлять некуда, и задача очереди для них была бы задачей, ' +
      'которая гарантированно упадёт.',
  })
  queued!: number;
}
