import { GroupStudentStatus, StudentStatus } from '@prisma/client';

/** Членство студента в группе в том виде, в каком его читает правило статуса. */
export interface MembershipStatusSnapshot {
  status: GroupStudentStatus;
  /** Когда статус меняли (ТЗ 5.12: «причина и дата»); у действующего членства — `null`. */
  statusChangedAt: Date | null;
}

/**
 * Статус профиля студента (ТЗ 5.3) по статусам его членств в группах.
 *
 * Правило вынесено пользователю в сессии 0014 и связывает то, что сессия 0012
 * оставила разведённым: `GroupStudent.status` (учится ли в этой группе)
 * и `Student.status` (кто этот человек для центра). Без связи витрина
 * Left courses (ТЗ 5.12: «студенты со статусом No Active») разошлась бы
 * с членствами, где как раз лежат причина, дата и группа ухода.
 *
 * Как выводится:
 *   - есть действующее членство → `ACTIVE` (человек учится);
 *   - действующих нет → смотрим на **последнее по времени** закрытое членство:
 *     `FINISHED` → `FINISHED` (прошёл курс), `LEFT`/`TRANSFERRED` → `NO_ACTIVE`.
 *
 * Почему последнее, а не приоритет статусов: статус профиля отвечает на вопрос
 * «что с человеком сейчас». Выпускник, бросивший второй курс, по приоритету
 * «FINISHED важнее» навсегда остался бы выпускником и не попал бы в отчёт
 * по оттоку; по приоритету «NO_ACTIVE важнее» — наоборот, выпускник трёх курсов
 * числился бы покинувшим из-за одного давнего ухода. Последнее событие
 * не врёт ни в том, ни в другом случае.
 *
 * @param current статус профиля сейчас — нужен, чтобы не писать в БД без изменений.
 * @param memberships все членства студента, включая закрытые.
 * @returns новый статус либо `null`, если менять не нужно.
 */
export function deriveStudentStatus(
  current: StudentStatus,
  memberships: MembershipStatusSnapshot[],
): StudentStatus | null {
  // `BLOCK` — запрет входа (ТЗ 5.3), а не факт учёбы: он снимается только
  // руками, иначе разблокировка происходила бы сама при зачислении в группу.
  if (current === StudentStatus.BLOCK) return null;

  // Профиль без учебной истории ведёт оператор: только что заведённого студента
  // (ТЗ 5.3 — «аккаунт опционален», человек может ждать набора) правило
  // не имеет права ни во что переводить.
  if (memberships.length === 0) return null;

  const next = statusOf(memberships);

  return next === current ? null : next;
}

const statusOf = (memberships: MembershipStatusSnapshot[]): StudentStatus => {
  if (memberships.some((m) => m.status === GroupStudentStatus.ACTIVE)) {
    return StudentStatus.ACTIVE;
  }

  const last = latestClosed(memberships);

  return last?.status === GroupStudentStatus.FINISHED
    ? StudentStatus.FINISHED
    : StudentStatus.NO_ACTIVE;
};

/**
 * Последнее закрытое членство. Дата стоит у каждого закрытого членства
 * (её ставят и смена статуса, и перевод), но membership без даты всё равно
 * учитывается — как самое давнее, а не отбрасывается: иначе строка,
 * закрытая в обход сервиса, выпала бы из вывода вместе со своим студентом.
 */
const latestClosed = (
  memberships: MembershipStatusSnapshot[],
): MembershipStatusSnapshot | undefined =>
  memberships.reduce<MembershipStatusSnapshot | undefined>((latest, current) => {
    if (latest === undefined) return current;

    const at = current.statusChangedAt?.getTime() ?? 0;
    const latestAt = latest.statusChangedAt?.getTime() ?? 0;

    return at > latestAt ? current : latest;
  }, undefined);
