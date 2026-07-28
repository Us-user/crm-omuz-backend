import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { StudentStatus } from '@prisma/client';

import {
  BusinessRuleException,
  emptyToNull,
  emptyToNullPatch,
  formatIsoDate,
  Paginated,
  parseIsoDate,
} from '../common';
// Прямым путём, а не через barrel: нужны только чистые функции правила,
// а не сервис и репозиторий успеваемости (правило сессии 0007).
import {
  ACTIVITY_CATEGORY_TITLES,
  activityCategoryOf,
  roundScore,
} from '../performance/performance';
import { PhoneService } from '../phone';
import type {
  CreateStudentDto,
  StudentDeletedDto,
  StudentDto,
  StudentQueryDto,
  UpdateStudentDto,
} from './dto';
import type { StudentDeletionCheck, StudentRow } from './students.repository';
import { StudentsRepository } from './students.repository';

/**
 * Успеваемость студента в строке списка: общий балл, категория активности
 * и корона. Считается отдельным агрегатом по `WeekResult`, а не хранится
 * в профиле (решение сессии 0019).
 */
interface StudentScore {
  averageScore: number | null;
  isTopStudent: boolean;
}

/** У студента без единой закрытой недели балла нет — и категории тоже. */
const NO_SCORE: StudentScore = { averageScore: null, isTopStudent: false };

/**
 * Студенты (ТЗ 5.3) — админ-сторона: список с фильтрами, карточка, форма.
 *
 * Правила модуля:
 *   - телефон уникален среди студентов (409): по нему человек находится
 *     в импорте состава (сессия 0013) и по нему же выдаётся логин;
 *   - филиал из тела должен существовать (422, а не 404: ресурс из пути найден,
 *     не найдено то, что пришло в теле — как в группах и аудиториях);
 *   - профиль с учебной историей не удаляется (409): членства в группах хранят
 *     причины и даты ухода (ТЗ 5.12), и снести их одной кнопкой нельзя.
 *     Для «человек больше не учится» есть статусы `NO_ACTIVE` и `BLOCK`.
 *
 * Аккаунт здесь не создаётся: ТЗ 5.3 называет его опциональным и выдаёт
 * отдельным действием «Invite». Зато при удалении профиля аккаунт уходит
 * вместе с ним — логина без профиля ТЗ 3.1 не допускает.
 */
@Injectable()
export class StudentsService {
  private readonly logger = new Logger(StudentsService.name);

  constructor(
    private readonly repository: StudentsRepository,
    private readonly phones: PhoneService,
  ) {}

  async findAll(query: StudentQueryDto): Promise<Paginated<StudentDto>> {
    const { rows, total } = await this.repository.findMany({
      search: query.search,
      status: query.status,
      branchId: query.branchId,
      groupId: query.groupId,
      courseId: query.courseId,
      hasAccount: query.hasAccount,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    const scores = await this.scoresOf(rows);

    return Paginated.from(
      rows.map((row) => toDto(row, scores.get(row.id) ?? NO_SCORE)),
      total,
      query,
    );
  }

  async findOne(id: string): Promise<StudentDto> {
    const student = await this.require(id);
    const scores = await this.scoresOf([student]);

    return toDto(student, scores.get(student.id) ?? NO_SCORE);
  }

  async create(dto: CreateStudentDto): Promise<StudentDto> {
    const phone = this.phones.normalize(dto.phone, 'phone');
    await this.assertPhoneFree(phone);

    const branchId = emptyToNull(dto.branchId);
    if (branchId !== null) await this.assertBranchExists(branchId);

    const student = await this.repository.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone,
      birthDate: parseOptionalDate(dto.birthDate, 'birthDate'),
      gender: dto.gender ?? null,
      address: emptyToNull(dto.address),
      email: emptyToNull(dto.email),
      extraPhones: this.normalizeExtraPhones(dto.extraPhones) ?? [],
      telegram: emptyToNull(dto.telegram),
      photoUrl: emptyToNull(dto.photoUrl),
      notes: emptyToNull(dto.notes),
      branchId,
      status: dto.status,
    });

    this.logger.log(`Создан студент ${student.lastName} ${student.firstName} (${student.id})`);

    // Балл не запрашивается: у профиля, созданного секунду назад, не может быть
    // ни одной закрытой недели — запрос вернул бы пустоту за деньги.
    return toDto(student, NO_SCORE);
  }

  async update(id: string, dto: UpdateStudentDto): Promise<StudentDto> {
    const current = await this.require(id);
    if (dto.status !== undefined) this.assertBlockNotCrossed(current.status, dto.status);

    // Телефон обязателен и очистке не подлежит: пустая строка не пройдёт
    // разбор и вернётся честным 400, а не молча оставит прежний номер.
    const phone = dto.phone === undefined ? undefined : this.phones.normalize(dto.phone, 'phone');
    if (phone !== undefined) await this.assertPhoneFree(phone, id);

    const branchId = emptyToNullPatch(dto.branchId);
    if (branchId !== undefined && branchId !== null) await this.assertBranchExists(branchId);

    const student = await this.repository.update(id, {
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone,
      birthDate: parseOptionalDatePatch(dto.birthDate, 'birthDate'),
      gender: dto.gender,
      address: emptyToNullPatch(dto.address),
      email: emptyToNullPatch(dto.email),
      extraPhones: this.normalizeExtraPhones(dto.extraPhones),
      telegram: emptyToNullPatch(dto.telegram),
      photoUrl: emptyToNullPatch(dto.photoUrl),
      notes: emptyToNullPatch(dto.notes),
      branchId,
      status: dto.status,
    });

    this.logger.log(`Изменён студент ${student.lastName} ${student.firstName} (${student.id})`);

    const scores = await this.scoresOf([student]);

    return toDto(student, scores.get(student.id) ?? NO_SCORE);
  }

  async remove(id: string): Promise<StudentDeletedDto> {
    const student = await this.repository.findForDeletion(id);
    if (!student) {
      throw new NotFoundException('Студент не найден');
    }

    this.assertDeletable(student);

    await this.repository.delete(id, student.accountId);

    const fullName = `${student.lastName} ${student.firstName}`;
    this.logger.log(
      `Удалён студент ${fullName} (${id})` +
        (student.accountId === null ? '' : ' вместе с его аккаунтом'),
    );

    return { id, fullName, accountDeleted: student.accountId !== null };
  }

  /**
   * Общий балл и корона для строк ответа (ТЗ 5.3, 5.8).
   *
   * Два запроса на страницу, а не на строку: агрегат по всем студентам сразу
   * и один наибольший балл центра. Корона сравнивается по **неокруглённым**
   * значениям — иначе двое с 87.334 и 87.335 показали бы одинаковые 87.33
   * и оба оказались бы первыми.
   *
   * Короны нет у того, кто сейчас не учится: он не участвует в рейтинге
   * (решение сессии 0019), и совпадение его балла с вершиной ничего не значит.
   * Действующие членства уже лежат в строке — второго запроса не нужно.
   */
  private async scoresOf(rows: StudentRow[]): Promise<Map<string, StudentScore>> {
    if (rows.length === 0) return new Map();

    const [scores, topAverage] = await Promise.all([
      this.repository.aggregateScores(rows.map(({ id }) => id)),
      this.repository.findTopAverage(),
    ]);

    const studying = new Set(rows.filter((row) => row.groups.length > 0).map(({ id }) => id));

    return new Map(
      scores.map(({ studentId, average }) => [
        studentId,
        {
          averageScore: roundScore(average),
          isTopStudent: topAverage !== null && average === topAverage && studying.has(studentId),
        },
      ]),
    );
  }

  private async require(id: string): Promise<StudentRow> {
    const student = await this.repository.findById(id);
    if (!student) {
      throw new NotFoundException('Студент не найден');
    }

    return student;
  }

  private async assertPhoneFree(phone: string, exceptId?: string): Promise<void> {
    const twin = await this.repository.findByPhone(phone);
    if (twin && twin.id !== exceptId) {
      throw new ConflictException(
        `Телефон ${phone} уже записан за студентом ${twin.lastName} ${twin.firstName}`,
      );
    }
  }

  /**
   * `BLOCK` через правку карточки не ставится и не снимается — 422 с указанием
   * на `POST /students/{id}/block`.
   *
   * Причина не в аккуратности маршрутов: по ТЗ 5.3 Block — это **блок входа**,
   * то есть статус профиля и `Account.status` вместе. Разрешив ставить `BLOCK`
   * формой, мы получили бы студента, помеченного заблокированным, который
   * продолжает входить в систему; разрешив снимать — наоборот, «активного»
   * студента, которому вход по-прежнему закрыт. Оба состояния выглядят
   * работающими и расходятся молча.
   */
  private assertBlockNotCrossed(current: StudentStatus, next: StudentStatus): void {
    if (next === current) return;

    if (next === StudentStatus.BLOCK) {
      throw new BusinessRuleException(
        'Статус «Block» ставится действием POST /students/{id}/block — оно же закрывает вход (ТЗ 5.3)',
        { status: next },
      );
    }

    if (current === StudentStatus.BLOCK) {
      throw new BusinessRuleException(
        'Студент заблокирован: снимите блокировку действием POST /students/{id}/block — ' +
          'иначе статус изменится, а вход останется закрытым',
        { status: current },
      );
    }
  }

  private async assertBranchExists(branchId: string): Promise<void> {
    const branch = await this.repository.findBranch(branchId);
    if (!branch) {
      throw new BusinessRuleException('Филиал не найден', { branchId });
    }
  }

  /**
   * Профиль удаляется только «чистым». Причина не в целостности — членства
   * каскадные, и БД такое удаление пропустит, — а в данных: вместе со строкой
   * студента исчезли бы причины и даты его ухода из групп (ТЗ 5.12), отметки
   * в журнале и начисленные коины (ТЗ 5.8, 5.9). Восстановить их было бы неоткуда.
   *
   * Журнал и коины проверяются отдельно от членств: отметка ссылается
   * на профиль, а не на членство (решение сессии 0018), поэтому у исключённого
   * из состава студента баллы остаются — и одних членств для проверки мало.
   */
  private assertDeletable(student: StudentDeletionCheck): void {
    const held = [
      ['членства в группах', student._count.groups],
      ['отметки в журнале', student._count.journalEntries],
      ['начисления коинов', student._count.coinTransactions],
      ['победы в рейтинге месяца', student._count.monthlyWins],
      ['выпуски с курсов', student._count.graduations],
    ].filter(([, count]) => (count as number) > 0);

    if (held.length > 0) {
      throw new ConflictException(
        `У студента есть учебная история: ${held
          .map(([label, count]) => `${String(label)} (${String(count)})`)
          .join(', ')} — исключите его из групп или переведите в статус ` +
          '«No Active» вместо удаления',
      );
    }

    // Лид, переведённый в этот профиль (ТЗ 5.7). Внешний ключ стоит `RESTRICT`,
    // и это осознанно: удаление профиля молча превратило бы переведённое
    // обращение в непереведённое, то есть переписало бы воронку задним числом.
    // Выход прямой и назван в тексте: сначала удаляется лид.
    if (student.leadOrigin !== null) {
      throw new ConflictException(
        'Профиль заведён переводом лида — удалите сам лид, если он ошибочный: ' +
          'иначе воронка потеряет, чем закончилось обращение',
      );
    }

    // Профиль переведённого студента — это учебная история сотрудника (ТЗ 3.1),
    // и на неё ссылается `Employee.formerStudentId`. Удаление обнулило бы ссылку
    // молча: связь «кем этот сотрудник был раньше» просто пропала бы.
    if (student.promotedEmployee !== null) {
      throw new ConflictException(
        'Студент переведён в сотрудники — его профиль хранит учебную историю и не удаляется',
      );
    }
  }

  /**
   * Дополнительные телефоны в E.164 без повторов (ТЗ 5.3, 3.1). Пустой массив
   * очищает список, не переданное поле — не трогает.
   *
   * Повторы отбрасываются молча: один и тот же номер, введённый дважды в разных
   * форматах, — это опечатка оператора, а не запрос, который стоит отклонять.
   */
  private normalizeExtraPhones(phones: string[] | undefined): string[] | undefined {
    if (phones === undefined) return undefined;

    const normalized = phones
      .map((phone, index) => this.phones.normalizeOptional(phone, `extraPhones[${String(index)}]`))
      .filter((phone): phone is string => phone !== undefined);

    return [...new Set(normalized)];
  }
}

const parseOptionalDate = (value: string | undefined, field: string): Date | null =>
  value === undefined || value === '' ? null : parseIsoDate(value, field);

const parseOptionalDatePatch = (
  value: string | undefined,
  field: string,
): Date | null | undefined => (value === undefined ? undefined : parseOptionalDate(value, field));

const toDto = (row: StudentRow, score: StudentScore): StudentDto => ({
  id: row.id,
  firstName: row.firstName,
  lastName: row.lastName,
  phone: row.phone,
  birthDate: row.birthDate === null ? null : formatIsoDate(row.birthDate),
  gender: row.gender,
  address: row.address,
  email: row.email,
  parents: row.parents.map(({ parent, relation }) => ({
    id: parent.id,
    firstName: parent.firstName,
    lastName: parent.lastName,
    phone: parent.phone,
    relation,
  })),
  extraPhones: row.extraPhones,
  telegram: row.telegram,
  photoUrl: row.photoUrl,
  notes: row.notes,
  branch: row.branch,
  status: row.status,
  account: row.account,
  activeGroups: row.groups.map(({ group }) => ({
    id: group.id,
    name: group.name,
    courseId: group.courseId,
    courseTitle: group.course.title,
  })),
  groupsCount: row._count.groups,
  averageScore: score.averageScore,
  activityCategory: activityCategoryOf(score.averageScore),
  activityCategoryTitle: titleOf(score.averageScore),
  isTopStudent: score.isTopStudent,
  createdAt: row.createdAt.toISOString(),
});

const titleOf = (score: number | null): string | null => {
  const category = activityCategoryOf(score);

  return category === null ? null : ACTIVITY_CATEGORY_TITLES[category];
};
