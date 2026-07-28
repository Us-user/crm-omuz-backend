import type { DirectoryStatus } from '@prisma/client';

/** Период действия купона: обе границы необязательны и включающие (ТЗ 5.7). */
export interface CouponPeriod {
  status: DirectoryStatus;
  validFrom: Date | null;
  validTo: Date | null;
}

/**
 * Действует ли купон на указанный день (ТЗ 5.7).
 *
 * Чистая функция, а не колонка в БД: «истёк» — это сравнение `validTo`
 * с сегодняшним днём, и хранимая копия того же факта разошлась бы с датами
 * в первый же день (то же соображение, что с флагом сертификата, 0026).
 *
 * Границы **включающие**: купон «до 30 ноября» действует тридцатого. Пустая
 * граница — открытый конец: бессрочная акция это законное состояние, а не
 * запись без даты окончания.
 *
 * Статус входит в правило наравне с датами: `INACTIVE` — это «акцию выключили
 * раньше срока», и купон, который по датам ещё жив, но выведен из работы,
 * не действует.
 */
export const isCouponValidOn = (coupon: CouponPeriod, on: Date): boolean =>
  coupon.status === 'ACTIVE' &&
  (coupon.validFrom === null || coupon.validFrom.getTime() <= on.getTime()) &&
  (coupon.validTo === null || coupon.validTo.getTime() >= on.getTime());
