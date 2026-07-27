import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ParentRelation } from '@prisma/client';

import { emptyToNull, emptyToNullPatch, Paginated } from '../common';
import { PhoneService } from '../phone';
import type {
  CreateStudentParentDto,
  StudentParentDto,
  StudentParentLinkedDto,
  StudentParentQueryDto,
  StudentParentUnlinkedDto,
  UpdateStudentParentDto,
} from './dto';
import type { ParentLinkRow, ParentRow, ParentWriteInput } from './student-parents.repository';
import { StudentParentsRepository } from './student-parents.repository';

/**
 * Родители и опекуны студента (ТЗ 4: Parent/Guardian; форма ТЗ 3.1 собирает
 * телефон родителя при регистрации).
 *
 * Правила модуля:
 *   - запись родителя **общая**: у одного человека бывает несколько детей
 *     в центре, и вторая копия его контактов разошлась бы с первой на первой же
 *     смене номера, а обзвон родителей группы посчитал бы его дважды;
 *   - родитель узнаётся **по телефону** — внутреннего идентификатора у оператора
 *     нет, а номер он и так вводит (тот же ключ, по которому импорт состава
 *     находит студентов, сессия 0013). Поэтому добавление второму ребёнку
 *     не заводит запись заново, а привязывает существующую;
 *   - степень родства живёт на связке: один и тот же человек бывает матерью
 *     одному ребёнку и опекуном другому;
 *   - отвязка последнего ребёнка удаляет запись целиком: отдельного справочника
 *     `/parents` нет, и родитель без детей стал бы недостижимой строкой.
 */
@Injectable()
export class StudentParentsService {
  private readonly logger = new Logger(StudentParentsService.name);

  constructor(
    private readonly repository: StudentParentsRepository,
    private readonly phones: PhoneService,
  ) {}

  async findAll(
    studentId: string,
    query: StudentParentQueryDto,
  ): Promise<Paginated<StudentParentDto>> {
    await this.requireStudent(studentId);

    const { rows, total } = await this.repository.findMany({
      studentId,
      search: query.search,
      relation: query.relation,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  async create(studentId: string, dto: CreateStudentParentDto): Promise<StudentParentLinkedDto> {
    await this.requireStudent(studentId);

    const phone = this.phones.normalize(dto.phone, 'phone');
    const relation = relationOf(dto.relation);
    const existing = await this.repository.findParentByPhone(phone);

    if (existing === null) {
      const link = await this.repository.create({
        studentId,
        parent: {
          phone,
          firstName: emptyToNull(dto.firstName),
          lastName: emptyToNull(dto.lastName),
          email: emptyToNull(dto.email),
          telegram: emptyToNull(dto.telegram),
          notes: emptyToNull(dto.notes),
        },
        relation,
      });

      this.logger.log(`Студенту ${studentId} добавлен родитель ${phone} (${link.parent.id})`);

      return { ...toDto(link), created: true };
    }

    const linked = await this.repository.findLink(studentId, existing.id);
    if (linked !== null) {
      throw new ConflictException(
        `Родитель с телефоном ${phone} уже записан у этого студента${nameSuffix(existing)}`,
      );
    }

    const link = await this.repository.link({
      studentId,
      parentId: existing.id,
      relation,
      fill: fillOf(existing, dto),
    });

    this.logger.log(
      `Студенту ${studentId} привязан существующий родитель ${phone} (${existing.id})`,
    );

    return { ...toDto(link), created: false };
  }

  async update(
    studentId: string,
    parentId: string,
    dto: UpdateStudentParentDto,
  ): Promise<StudentParentDto> {
    await this.requireStudent(studentId);
    await this.requireLink(studentId, parentId);

    // Телефон — ключ записи и очистке не подлежит: пустая строка не пройдёт
    // разбор и вернётся честным 400, а не молча оставит прежний номер
    // (то же правило, что у телефона студента).
    const phone = dto.phone === undefined ? undefined : this.phones.normalize(dto.phone, 'phone');
    if (phone !== undefined) await this.assertPhoneFree(phone, parentId);

    const link = await this.repository.update({
      studentId,
      parentId,
      parent: definedOnly({
        phone,
        firstName: emptyToNullPatch(dto.firstName),
        lastName: emptyToNullPatch(dto.lastName),
        email: emptyToNullPatch(dto.email),
        telegram: emptyToNullPatch(dto.telegram),
        notes: emptyToNullPatch(dto.notes),
      }),
      relation: dto.relation === undefined ? undefined : relationOf(dto.relation),
    });

    this.logger.log(`Изменён родитель ${link.parent.phone} (${parentId}) студента ${studentId}`);

    return toDto(link);
  }

  async remove(studentId: string, parentId: string): Promise<StudentParentUnlinkedDto> {
    await this.requireStudent(studentId);
    const link = await this.requireLink(studentId, parentId);

    const { parentDeleted } = await this.repository.unlink(studentId, parentId);

    this.logger.log(
      `У студента ${studentId} убран родитель ${link.parent.phone} (${parentId})` +
        (parentDeleted ? ' вместе с записью — других детей в центре у него нет' : ''),
    );

    return {
      id: parentId,
      phone: link.parent.phone,
      fullName: fullNameOf(link.parent),
      parentDeleted,
    };
  }

  private async requireStudent(id: string): Promise<void> {
    const student = await this.repository.findStudent(id);
    if (!student) {
      throw new NotFoundException('Студент не найден');
    }
  }

  /**
   * Родитель ищется вместе со студентом из пути, а студент проверяется отдельным
   * запросом: иначе опечатка в идентификаторе студента выглядела бы как пропавший
   * родитель. Сообщения разведены — то же решение, что с курсом в силлабусе.
   */
  private async requireLink(studentId: string, parentId: string): Promise<ParentLinkRow> {
    const link = await this.repository.findLink(studentId, parentId);
    if (!link) {
      throw new NotFoundException('Родитель не записан у этого студента');
    }

    return link;
  }

  /**
   * Телефон — ключ записи родителя: сменить его на занятый другим родителем
   * нельзя. Проверка до записи, чтобы отдать понятный 409 вместо обезличенного
   * «запись с такими значениями уже существует» (P2002).
   *
   * Слить двух родителей сменой телефона намеренно нельзя: это молча перенесло бы
   * детей одной записи на другую.
   */
  private async assertPhoneFree(phone: string, exceptId: string): Promise<void> {
    const twin = await this.repository.findParentByPhone(phone);
    if (twin && twin.id !== exceptId) {
      throw new ConflictException(
        `Телефон ${phone} уже записан за другим родителем${nameSuffix(twin)} — ` +
          'привяжите его к студенту вместо смены номера',
      );
    }
  }
}

/** Пустая строка и отсутствие значения — одно и то же: степень родства не указана. */
const relationOf = (value: ParentRelation | undefined): ParentRelation | null =>
  value === undefined || (value as string) === '' ? null : value;

/**
 * Чем дозаполнить уже существующую запись родителя.
 *
 * Заполненные поля не перезаписываются: запись общая, и «поправив» имя здесь,
 * оператор молча изменил бы карточку чужого ребёнка. Зато пустые поля заполнить
 * нужно — иначе самый частый случай (регистрация завела родителя по одному
 * номеру, а администратор потом ввёл ФИО) молча терял бы введённое.
 * Осознанная правка общей записи делается через `PUT`, где она видна.
 */
const fillOf = (existing: ParentRow, dto: CreateStudentParentDto): ParentWriteInput =>
  definedOnly({
    firstName: existing.firstName === null ? filled(dto.firstName) : undefined,
    lastName: existing.lastName === null ? filled(dto.lastName) : undefined,
    email: existing.email === null ? filled(dto.email) : undefined,
    telegram: existing.telegram === null ? filled(dto.telegram) : undefined,
    notes: existing.notes === null ? filled(dto.notes) : undefined,
  });

/**
 * Значение поля, если оператор его действительно прислал.
 *
 * Здесь, в отличие от создания, пустая строка означает не «очистить», а «нечем
 * дозаполнить»: поле записи и так пустое, и запись `null` поверх `null` была бы
 * лишним обращением к БД ради ничего.
 */
const filled = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/**
 * Убирает ключи со значением `undefined`. Prisma такие поля и так пропускает,
 * но по числу оставшихся ключей репозиторий решает, нужен ли запрос вообще.
 */
const definedOnly = (input: ParentWriteInput): ParentWriteInput =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

const fullNameOf = (parent: { firstName: string | null; lastName: string | null }): string | null =>
  [parent.lastName, parent.firstName].filter((part) => part !== null).join(' ') || null;

const nameSuffix = (parent: { firstName: string | null; lastName: string | null }): string => {
  const fullName = fullNameOf(parent);
  return fullName === null ? '' : ` (${fullName})`;
};

const toDto = (row: ParentLinkRow): StudentParentDto => ({
  id: row.parent.id,
  firstName: row.parent.firstName,
  lastName: row.parent.lastName,
  phone: row.parent.phone,
  email: row.parent.email,
  telegram: row.parent.telegram,
  notes: row.parent.notes,
  relation: row.relation,
  childrenCount: row.parent._count.students,
  linkedAt: row.createdAt.toISOString(),
});
